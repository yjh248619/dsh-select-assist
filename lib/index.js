import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
//#region src/companion.ts
/**
* 系统级划词伴生进程的生命周期管理。
*
* 插件本体跑在 dsh 进程里，做不了"全局划词 + 置顶浮层"这类系统级动作，
* 于是把这块交给一个独立的 Node 伴生进程（companion/main.mjs，用 dsh 自带的
* koffi 调 Win32）。这里只负责：按需拉起、读取它上报的端口、异常退出后退避重启、
* 插件卸载时收尸。
*
* 伴生进程崩溃或不可用，只影响"系统级划词"这一条能力，DSH 本体与页内划词不受影响。
*/
/** 伴生进程入口（本包内的相对路径）。 */
const COMPANION_ENTRY = fileURLToPath(new URL("../companion/main.mjs", import.meta.url));
/** 监听端口上报的日志行：\`... listening on http://127.0.0.1:<port>\`。 */
const PORT_PATTERN = /listening on http:\/\/127\.0\.0\.1:(\d+)/;
/**
* 创建伴生进程管理器。
* @param ctx - 插件上下文。
* @param options - 见 {@link CompanionManagerOptions}。
*/
function createCompanionManager(ctx, options = {}) {
	const enabled = options.enabled !== false;
	const maxRestarts = options.maxRestarts ?? 5;
	const killGraceMs = options.killGraceMs ?? 800;
	const restartDelayMs = options.restartDelayMs ?? ((attempt) => Math.min(3e4, 1e3 * 2 ** attempt));
	let child = null;
	let restartTimer = null;
	let stopping = false;
	let status = {
		state: "stopped",
		restarts: 0
	};
	/** dsh 安装目录里的某个文件（用作 koffi 解析锚点）。 */
	function koffiHint() {
		const argv1 = process.argv[1];
		return typeof argv1 === "string" && argv1.endsWith(".js") ? argv1 : "";
	}
	/** 进程还活着吗（抛 ESRCH = 已经退出）。 */
	function isAlive(pid) {
		if (pid === void 0 || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}
	/**
	* 兜底强杀。
	*
	* \`ChildProcess.kill()\` 偶尔漏杀（踩过：/system/restart 之后老伴生进程还活着，
	* 于是两个进程各自钩全局鼠标、各自开浮层——用户会看到两个菜单、两个回答窗口，
	* 而插件自己只认得新的那一个）。宽限期内没死就直接 taskkill；本插件只支持 Windows。
	*/
	function forceKill(pid) {
		if (pid === void 0 || pid <= 0 || process.platform !== "win32") return;
		try {
			const killer = spawn("taskkill", [
				"/pid",
				String(pid),
				"/T",
				"/F"
			], {
				stdio: "ignore",
				windowsHide: true
			});
			killer.on("error", () => {});
			killer.unref?.();
		} catch {}
	}
	/** 默认拉起方式：起一个 node 子进程跑伴生进程入口。 */
	function spawnDefault() {
		const port = ctx.webServer?.port;
		const origin = typeof port === "number" && port > 0 ? "http://127.0.0.1:" + port : "http://127.0.0.1:3080";
		return spawn(process.execPath, [COMPANION_ENTRY], {
			env: {
				...process.env,
				DSH_SELECTION_DSH_ORIGIN: origin,
				DSH_SELECTION_KOFFI_HINT: koffiHint()
			},
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
	}
	const spawnChild = options.spawnChild ?? spawnDefault;
	/** 启动伴生进程。 */
	function start() {
		if (!enabled || stopping || child !== null) return;
		status = {
			state: "starting",
			restarts: status.restarts,
			startedAt: Date.now()
		};
		const spawned = spawnChild();
		child = spawned;
		spawned.stdout?.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			const match = PORT_PATTERN.exec(text);
			if (match !== null) {
				status = {
					...status,
					state: "running",
					port: Number(match[1]),
					pid: spawned.pid
				};
				ctx.logger?.info?.("dsh-select-assist: companion ready on " + match[1]);
			}
		});
		spawned.stderr?.on("data", (chunk) => {
			const text = chunk.toString("utf8").trim();
			if (text !== "") status = {
				...status,
				lastError: text.slice(-400)
			};
		});
		spawned.on("exit", (code, signal) => {
			if (child !== spawned) return;
			child = null;
			if (stopping) {
				status = {
					...status,
					state: "stopped",
					pid: void 0
				};
				return;
			}
			status = {
				...status,
				state: "failed",
				pid: void 0,
				lastError: "exited (code=" + String(code) + " signal=" + String(signal) + ")"
			};
			ctx.logger?.warn?.("dsh-select-assist: companion exited (code=" + String(code) + ")");
			if (status.restarts < maxRestarts) {
				status.restarts += 1;
				const delay = restartDelayMs(status.restarts);
				restartTimer = setTimeout(() => {
					restartTimer = null;
					if (!stopping) start();
				}, delay);
				restartTimer.unref?.();
			}
		});
	}
	/** 送走当前伴生进程：先 kill，宽限期内还活着就强杀。 */
	function killChild() {
		const doomed = child;
		child = null;
		if (doomed === null) return;
		const pid = doomed.pid;
		try {
			doomed.kill();
		} catch {}
		if (pid === void 0 || !isAlive(pid)) return;
		setTimeout(() => {
			if (isAlive(pid)) forceKill(pid);
		}, killGraceMs).unref?.();
	}
	/** 停止伴生进程（并取消排队中的自动重启）。 */
	function stop() {
		stopping = true;
		if (restartTimer !== null) {
			clearTimeout(restartTimer);
			restartTimer = null;
		}
		killChild();
		status = {
			...status,
			state: "stopped",
			pid: void 0
		};
	}
	/** 等目标进程真的退出（最多 timeoutMs；超时也不阻塞调用方）。 */
	function waitForExit(target, timeoutMs) {
		if (target === null || target.exitCode !== null || target.signalCode !== null) return Promise.resolve();
		return new Promise((resolve) => {
			let timer = null;
			const finish = () => {
				if (timer !== null) clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(() => {
				target.removeListener("exit", finish);
				finish();
			}, timeoutMs);
			timer.unref?.();
			target.once("exit", finish);
		});
	}
	/**
	* 重启：先送走老进程、**等它真的退出**，再拉起新的。
	*
	* 两处不能省：等退出是为了不出现"新老两个伴生进程同时活着"（两个全局钩子抢鼠标）；
	* 复位 \`stopping\` 是因为它只在 stop() 里置位——不复位的话看门狗就永久失效了
	* （踩过：/system/restart 之后伴生进程再崩也不会自动重启）。
	*/
	async function restart() {
		const doomed = child;
		stop();
		await waitForExit(doomed, killGraceMs + 700);
		stopping = false;
		start();
	}
	return {
		start,
		stop,
		restart,
		status: () => ({
			...status,
			enabled,
			entry: COMPANION_ENTRY
		}),
		/** 把伴生进程绑到插件生命周期上。 */
		install() {
			ctx.effect(() => {
				start();
				return () => {
					stop();
				};
			}, "dsh-select-assist: companion");
		}
	};
}
//#endregion
//#region src/shared/protocol.ts
/**
* 跨 host/client 的稳定协议：路由前缀、请求体、SSE 事件。
*
* host 半边在 webServer 上注册 `/api/dsh-select-assist/*` 路由，
* 浏览器半边用同源 fetch 调用（POST + SSE 流式返回）。
*/
/** 插件 id：bundle 行 name、client bundle 注册 id、日志标签共用。 */
const PLUGIN_ID = "dsh-select-assist";
/** 插件自有 HTTP 路由前缀（host half 注册，client half fetch）。 */
const API_PREFIX = "/api/dsh-select-assist";
/** 一次划词请求允许的最大字符数（超出直接拒绝，避免意外把整篇文档塞给模型）。 */
const MAX_SELECTION_LENGTH = 12e3;
/** 上下文段落允许的最大字符数（系统级取词用 UIA 读选区所在段落，超长直接截断）。 */
const MAX_CONTEXT_LENGTH = 4e3;
/** 直连引擎遇到"上游一时忙"时的最大尝试次数（含第一次）。 */
const DIRECT_MAX_ATTEMPTS = 5;
/** 同一个模型上先试几次，再考虑换到模型链里的下一个。 */
const DIRECT_TRIES_PER_MODEL = 2;
/**
* 这类失败是"上游一时忙"，原样重试就有机会成功。
*
* 实测 opencode 网关在高峰期会交替返回 200 / `429 [overloaded]`（同一个会话也能
* 连中四次），所以划词直连这条路必须自己重试——DSH 的 agent 通道有 llm-retry 兜着，
* 直连通道没有。
* @param message - 失败原文。
* @returns 是否值得重试。
*/
function isTransientFailure(message) {
	return /429|overloaded|rate.?limit|too many requests|502|503|504|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(String(message));
}
/**
* 一次尝试里「上游迟迟不吐字」的容忍时间（毫秒）。
*
* 上游过载时最常见的一种坏法不是报错，而是把连接挂着不回：没有这道闸，浮窗会
* 一直转圈、重试逻辑也永远不会触发。到点就掐掉这一次，按瞬时失败重试。
*/
const DIRECT_IDLE_MS = 45e3;
/**
* 配额/资格类错误：重试同一个模型没有意义（额度不会在 500ms 内恢复），
* 而且对上游的限流 hold 只会越续越长。这类错误直接换模型。
* @param message - 失败原文。
* @returns 是否属于"别重试同模型"的错误。
*/
function isQuotaExhausted(message) {
	return /FreeUsageLimitError|free usage limit|bili_throttle_hold|insufficient[ _-]?quota|quota exceeded|exceeded your current quota|billing|credit balance|余额|访问量过大|1305/i.test(String(message));
}
/** "跟随原文自动"（中文→英文，其余→中文）——保留旧行为的那个选项。 */
const AUTO_LANGUAGE_ID = "auto";
/** 可选语言（覆盖常用语种；加语言只需在这里加一行）。 */
const LANGUAGES = [
	{
		id: "zh-Hans",
		label: "简体中文",
		prompt: "Simplified Chinese"
	},
	{
		id: "zh-Hant",
		label: "繁體中文",
		prompt: "Traditional Chinese"
	},
	{
		id: "en",
		label: "English",
		prompt: "English"
	},
	{
		id: "ja",
		label: "日本語",
		prompt: "Japanese"
	},
	{
		id: "ko",
		label: "한국어",
		prompt: "Korean"
	},
	{
		id: "fr",
		label: "Français",
		prompt: "French"
	},
	{
		id: "de",
		label: "Deutsch",
		prompt: "German"
	},
	{
		id: "es",
		label: "Español",
		prompt: "Spanish"
	},
	{
		id: "pt",
		label: "Português",
		prompt: "Portuguese"
	},
	{
		id: "ru",
		label: "Русский",
		prompt: "Russian"
	},
	{
		id: "it",
		label: "Italiano",
		prompt: "Italian"
	},
	{
		id: "nl",
		label: "Nederlands",
		prompt: "Dutch"
	},
	{
		id: "pl",
		label: "Polski",
		prompt: "Polish"
	},
	{
		id: "sv",
		label: "Svenska",
		prompt: "Swedish"
	},
	{
		id: "tr",
		label: "Türkçe",
		prompt: "Turkish"
	},
	{
		id: "uk",
		label: "Українська",
		prompt: "Ukrainian"
	},
	{
		id: "ar",
		label: "العربية",
		prompt: "Arabic"
	},
	{
		id: "he",
		label: "עברית",
		prompt: "Hebrew"
	},
	{
		id: "fa",
		label: "فارسی",
		prompt: "Persian"
	},
	{
		id: "hi",
		label: "हिन्दी",
		prompt: "Hindi"
	},
	{
		id: "bn",
		label: "বাংলা",
		prompt: "Bengali"
	},
	{
		id: "th",
		label: "ไทย",
		prompt: "Thai"
	},
	{
		id: "vi",
		label: "Tiếng Việt",
		prompt: "Vietnamese"
	},
	{
		id: "id",
		label: "Bahasa Indonesia",
		prompt: "Indonesian"
	},
	{
		id: "ms",
		label: "Bahasa Melayu",
		prompt: "Malay"
	}
];
/** 取语言选项（未知 id 返回 undefined）。 */
function languageById(id) {
	return LANGUAGES.find((item) => item.id === id);
}
/** 解释规则默认文本。 */
const DEFAULT_EXPLAIN_RULES = [
	"- 结合语境解释选中的文本：它指什么、在这里起什么作用。",
	"- 先用一两句话说明它的含义，再分小节说明关键概念与背景；如果是代码，说明它的作用与执行过程。",
	"- 用 Markdown 组织回答，简洁准确，不要整段复述选中的文本或上文。",
	"- 不要评论有没有提供上文、也不要说明你是怎么判断语境的，直接给出解释。",
	"- 这是一次独立请求：只解释选中的文本，不要提及或评论任何先前的对话内容。"
].join("\n");
/**
* 翻译规则默认文本。
*
* 词/短语按词典条目给（最佳翻译 + 音标 + 其他翻译 + 术语说明），句子/段落给整段译文
* 并额外解释其中的关键术语与缩写——这些都靠规则驱动，模型自己判断是词还是句。
*/
const DEFAULT_TRANSLATE_RULES = [
	"- 先判断选中的是「词/短语」还是「句子/段落」，按对应格式输出。",
	"- 词或短语：按词典条目排版——",
	"  - 第一行：**最佳翻译**（最贴合当前语境的那一个译法）。",
	"  - 第二行：读音，写成 `英 /…/　美 /…/`（国际音标；中文等非表音文字可省略这一行）。",
	"  - 空一行后给 `其他翻译`：2~4 个其他义项，每条一行，写成 `- 译法 — 词性/领域，什么时候用`。",
	"  - 如果它是关键术语或缩写：再给一小节 `术语说明`，缩写先写全称，再用一句话说明它指什么。",
	"- 句子或段落：先给完整译文；如果句中出现了关键术语、缩写或专有名词，再追加小节 `关键术语`，逐条给出全称与一句解释（没有就不写这一节，不要硬凑）。",
	"- 只输出译文与上述小节：不要前言、不要复述原文、不要说明你是怎么判断词还是句子的。",
	"- 保留原文的格式、换行、行内代码与专有名词；如果原文已经是目标语言，原样返回。"
].join("\n");
/** 总结规则默认文本。 */
const DEFAULT_SUMMARIZE_RULES = [
	"- 先用一句话给出核心结论，再分「要点」小节逐条列出关键信息（每条一行，最多 5 条）。",
	"- 如果原文有明确的结构（章节、列表、对话轮次），保留它的大致层次再压缩。",
	"- 只保留原文真正说了的内容：不要补充背景知识，不要评价好坏，不要给建议。",
	"- 数字、专有名词、结论性判断必须原样保留，不要模糊成「一些」「若干」。",
	"- 用 Markdown 组织回答；原文很短时直接给一句话总结，不要硬凑要点。",
	"- 这是一次独立请求：只总结选中的文本，不要提及或评论任何先前的对话内容。"
].join("\n");
/** 默认设置。 */
const DEFAULT_SETTINGS = {
	engine: "direct",
	targetLanguage: AUTO_LANGUAGE_ID,
	fallbackLanguage: AUTO_LANGUAGE_ID,
	explainRules: DEFAULT_EXPLAIN_RULES,
	translateRules: DEFAULT_TRANSLATE_RULES,
	summarizeRules: DEFAULT_SUMMARIZE_RULES,
	translateModel: null,
	explainModel: null,
	summarizeModel: null,
	/**
	* 上游过载时是否允许跨 provider 兜底（开关）。
	*
	* 同 provider 的座位模型都打不通时，最后再试一个别的 provider——代价是选中的
	* 文字会被发到那家服务，所以做成开关，默认开但可以在设置页关掉。
	*/
	crossProviderFallback: true,
	/**
	* 跨 provider 兜底用的模型。
	*
	* 默认留空：装好后由用户自己选（不同用户能访问的服务商不一样，写死一个默认值
	* 等于替别人做了个可能用不了的决定）。为空时 resolveModelChain 不会追加
	* 跨 provider 的那一跳，行为等同关闭兜底。
	*/
	fallbackModel: null,
	/**
	* 「问问」时把选区所在的段落作为「上文」一起带进输入框引用（开关）。
	*
	* 会话里的 agent 看不到你刚在哪儿读的这段文字；带上一个自然段，追问时它才
	* 知道"这个词指的是什么"。代价只是输入框里多一小段引用，所以默认开。
	*/
	askIncludeContext: true,
	/**
	* 翻译走哪条通道：
	*
	* - `"bing"` / `"google"`：Bing / Google 浏览器同款的匿名机译端点（免登录、
	*   无 API key、延迟低）；失败或文本超长时自动退回下面配置的模型座位；
	* - `"llm"`：始终走模型座位。
	*
	* 解释与总结不受影响，永远走模型。
	*/
	translateEngine: "bing"
};
/** 规则文本上限（避免把提示词撑爆）。 */
const MAX_RULES_LENGTH = 4e3;
/**
* 把任意输入规整成合法设置（缺项补默认、非法值丢弃）。
* 主客两边共用：客户端在提交前也用它做一次本地校验。
*/
function normalizeSettings(input) {
	const raw = input ?? {};
	const language = (value, fallback) => {
		const id = typeof value === "string" ? value : "";
		if (id === "auto") return id;
		return languageById(id) === void 0 ? fallback : id;
	};
	const rules = (value, fallback) => {
		if (typeof value !== "string") return fallback;
		const text = value.replace(/\r\n/g, "\n").trim();
		if (text === "") return fallback;
		return text.length > 4e3 ? text.slice(0, MAX_RULES_LENGTH) : text;
	};
	const seat = (value) => {
		if (value === null || value === void 0 || typeof value !== "object") return null;
		const candidate = value;
		const provider = typeof candidate.provider === "string" ? candidate.provider.trim() : "";
		const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
		if (provider === "" || model === "") return null;
		const effort = typeof candidate.reasoningEffort === "string" ? candidate.reasoningEffort.trim() : "";
		return {
			provider,
			model,
			...effort === "" ? {} : { reasoningEffort: effort }
		};
	};
	const number = (value, fallback, range) => {
		const parsed = typeof value === "number" ? value : NaN;
		if (!Number.isFinite(parsed)) return fallback;
		return Math.max(range.min, Math.min(range.max, Math.round(parsed)));
	};
	return {
		engine: raw.engine === "agent" ? "agent" : "direct",
		targetLanguage: language(raw.targetLanguage, DEFAULT_SETTINGS.targetLanguage),
		fallbackLanguage: language(raw.fallbackLanguage, DEFAULT_SETTINGS.fallbackLanguage),
		explainRules: rules(raw.explainRules, DEFAULT_SETTINGS.explainRules),
		translateRules: rules(raw.translateRules, DEFAULT_SETTINGS.translateRules),
		summarizeRules: rules(raw.summarizeRules, DEFAULT_SETTINGS.summarizeRules),
		translateModel: seat(raw.translateModel),
		explainModel: seat(raw.explainModel),
		summarizeModel: seat(raw.summarizeModel),
		crossProviderFallback: raw.crossProviderFallback !== false,
		fallbackModel: raw.fallbackModel === null ? null : seat(raw.fallbackModel) ?? seat(DEFAULT_SETTINGS.fallbackModel),
		askIncludeContext: raw.askIncludeContext !== false,
		translateEngine: raw.translateEngine === "llm" || raw.translateEngine === "google" ? raw.translateEngine : "bing"
	};
}
//#endregion
//#region src/prompt.ts
/**
* 提示词构造：翻译 / 解释。
*
* 这里只负责「用户会怎么问」——真正干活的是 Harness 自己的 agent
* （同一个 agent loop、同一套系统提示与工具），因此行为与在 DSH 里
* 手敲同一句话完全一致。
*
* 「要求」那一段是**用户可编辑**的（设置页里改，存在 dsh-select-assist.json）：
* 解释/翻译的规则就是要交给模型的规则信息，不锁死在代码里。
*/
/** 文本里是否含 CJK 汉字。 */
function hasCjk(text) {
	return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
}
/** 文本里是否含日文假名。 */
function hasKana(text) {
	return /[\u3040-\u30ff]/.test(text);
}
/** 文本里是否含韩文谚文。 */
function hasHangul(text) {
	return /[\uac00-\ud7af]/.test(text);
}
/**
* 默认目标语言：源文本是中文 → 译成英文；否则译成中文。
* @param text - 选中文本。
* @param locale - 界面语言（决定中文写成「中文」还是「Chinese」）。
*/
function defaultTarget(text, locale) {
	return hasCjk(text) ? locale === "en" ? "English" : "英文" : locale === "en" ? "Chinese (Simplified)" : "中文";
}
/** 语言 id → 提示词里的语言名（中文界面下中/英用中文写法，其余用英文名）。 */
function languagePromptName(id, locale) {
	const option = languageById(id);
	if (option === void 0) return locale === "en" ? "Chinese (Simplified)" : "中文";
	if (locale === "en") return option.prompt;
	if (option.id === "zh-Hans") return "中文";
	if (option.id === "en") return "英文";
	return option.prompt;
}
/** 文本看着像不像某种语言（只做能可靠判断的几种，其余一律"不像"）。 */
function looksLikeLanguage(text, id) {
	if (id === "zh-Hans" || id === "zh-Hant") return hasCjk(text) && !hasKana(text);
	if (id === "ja") return hasKana(text);
	if (id === "ko") return hasHangul(text);
	return false;
}
/**
* 这一轮到底翻成什么语言。
*
* - 「默认翻译至」= auto：保持旧行为（中文→英文，其余→中文）；
* - 选了具体语言：就是它；要是原文已经是这个语言，改用「反向目标语言」
*   （fallback 也是 auto 时取镜像：原文是中文就译英文，否则译中文）。
*/
function resolveTarget(text, settings, locale) {
	const requested = settings.targetLanguage;
	if (requested === "auto") return defaultTarget(text, locale);
	if (!looksLikeLanguage(text, requested)) return languagePromptName(requested, locale);
	const fallback = settings.fallbackLanguage;
	if (fallback === "auto" || fallback === requested) return defaultTarget(text, locale);
	return languagePromptName(fallback, locale);
}
/**
* 机译通道要的语言标签（translator 服务收 BCP-47 风格，不是提示词里的语言名）。
*
* 规则与 {@link resolveTarget} 保持一致：auto 时中文译英文、其余译中文；显式
* 语言用它的 id；原文已经是目标语言时改用反向目标语言（同样 auto 时镜像）。
*
* @param text - 选中文本。
* @param settings - 当前设置。
*/
function mtTargetLanguage(text, settings) {
	const requested = settings.targetLanguage;
	const autoTag = () => hasCjk(text) ? "en" : "zh-Hans";
	if (requested === AUTO_LANGUAGE_ID) return autoTag();
	if (!looksLikeLanguage(text, requested)) return requested;
	const fallback = settings.fallbackLanguage;
	if (fallback === AUTO_LANGUAGE_ID || fallback === requested) return autoTag();
	return fallback;
}
/** 取规则文本（空串退回默认）。 */
function rulesOf(value, fallback) {
	const text = typeof value === "string" ? value.trim() : "";
	return text === "" ? fallback : text;
}
/** 提示词骨架（各语言一套）。 */
function skeleton(locale, action) {
	if (locale === "en") {
		const shared = {
			heading: "Requirements:",
			textLabel: "Selected text:",
			contextLabel: "Surrounding text (context only):"
		};
		if (action === "translate") return {
			intro: "Translate the text below into {target}.",
			...shared
		};
		if (action === "summarize") return {
			intro: "Summarize the text below.",
			...shared
		};
		return {
			intro: "Explain the text below.",
			...shared,
			contextLabel: "Surrounding text:"
		};
	}
	const shared = {
		heading: "要求：",
		textLabel: "选中的文本：",
		contextLabel: "上文（仅作语境，不要翻译）："
	};
	if (action === "translate") return {
		intro: "把下面的文本翻译成{target}。",
		...shared
	};
	if (action === "summarize") return {
		intro: "总结下面这段文本。",
		...shared
	};
	return {
		intro: "解释下面这段文本。",
		...shared,
		contextLabel: "上文："
	};
}
/**
* 构造本轮发给 agent 的用户消息。
* @param action - 翻译或解释。
* @param text - 选中文本。
* @param target - 目标语言（仅翻译用）。
* @param locale - 界面语言。
* @param context - 选中文本所在的上下文段落（没有就传空串）。
* @param rules - 该动作用户配置的"要求"文本（空串用默认）。
*/
function buildPrompt(action, text, target, locale, context = "", rules = "") {
	const trimmed = typeof context === "string" ? context.trim() : "";
	const parts = skeleton(locale, action);
	const requirement = rulesOf(rules, action === "translate" ? DEFAULT_TRANSLATE_RULES : action === "summarize" ? DEFAULT_SUMMARIZE_RULES : DEFAULT_EXPLAIN_RULES);
	const lines = [
		parts.intro.replace("{target}", target),
		"",
		parts.heading,
		requirement,
		"",
		parts.textLabel,
		"```",
		text,
		"```"
	];
	if (trimmed !== "") lines.push("", parts.contextLabel, "```", trimmed, "```");
	return lines.join("\n");
}
//#endregion
//#region src/settings.ts
/**
* 插件设置的宿主侧存取。
*
* 存哪儿：DSH home 下的 \`dsh-select-assist.json\`（\`DSH_HOME\` 优先，否则 \`~/.dsh\`）。
* 为什么不走 \`ctx.settings\`：那是宿主设置文档的一层，写进去需要宿主挂载 settings provider
* 与 schemastery schema；本插件要保持"零官方依赖、任何 profile 都能跑"，所以自带一个小
* 文件 + 自带 HTTP 路由（浏览器半边用同源 fetch 读写）。
*
* 读写都很便宜（几百字节），所以每次跑一轮前现读，不做缓存——用户改完设置立刻生效。
*/
/** 设置文件路径（\`DSH_HOME\` 优先）。 */
function settingsFilePath() {
	const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
	return join(home, "dsh-select-assist.json");
}
/** 读设置（文件缺失/损坏都退回默认值，绝不让设置拖垮划词）。 */
function loadSettings() {
	try {
		const raw = readFileSync(settingsFilePath(), "utf8");
		return normalizeSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}
/** 写设置（先写临时文件再改名，避免半截文件）。 */
function saveSettings(patch) {
	const merged = normalizeSettings({
		...loadSettings(),
		...typeof patch === "object" && patch !== null ? patch : {}
	});
	try {
		const file = settingsFilePath();
		mkdirSync(dirname(file), { recursive: true });
		const temporary = file + ".tmp";
		writeFileSync(temporary, JSON.stringify(merged, null, 2), "utf8");
		renameSync(temporary, file);
	} catch {}
	return merged;
}
//#endregion
//#region src/index.ts
/**
* dsh-select-assist —— host 半边（Cordis 插件）。
*
* 职责只有两件事：
* 1. 在 webServer 上注册 `/api/dsh-select-assist/*` 同源路由（run / stop / ping）。
* 2. `run` 里用 Harness 自己的 agent（ctx.agents）跑一轮真实的会话回合，
*    把 assistant 文本增量以 SSE 推给浏览器半边。
*
* 因为跑的是同一套 agent loop（同系统提示、同工具、同模型 route），
* 划词翻译/解释的行为与结果和直接在 DSH 里手敲同一句话一致；
* 会话本身也是一条真实会话，可以在 DSH 侧栏里打开继续对话。
*/
/** Cordis 插件名。 */
const name = PLUGIN_ID;
/**
* 硬依赖：路由宿主、agent 注册表、LLM 服务。
* （model route 默认值经 ctx.get('agentDefaultModel') 可选读取。）
*
* `agents` 只在 engine='agent' 那条老路径上用到；`llm` 是快路径的唯一依赖。
*/
const inject = [
	"webServer",
	"agents",
	"llm"
];
/** 每个会话串行执行，避免两次划词互相打断（仅 engine='agent' 路径）。 */
const queues = /* @__PURE__ */ new Map();
/** 正在跑的直连请求：runId → 中止器（`/stop` 用）。 */
const runs = /* @__PURE__ */ new Map();
/**
* 造一条与官方 `@deepseek-ai/dsh-llm` createUserMessage 等价的 user 消息。
*
* 这里刻意不 import 官方包：插件常以 `link:`/本地路径装进 profile，而 Node 按
* **真实路径**解析 import —— 官方包只在 `$DSH_HOME/profiles/node_modules` 里可达，
* 插件源码在别的盘符时就会 ERR_MODULE_NOT_FOUND（实测会让整个 dsh web 起不来）。
* 官方实现就是 `{ role:'user', content, source, id: uuid }` 再冻结，这里照做。
*
* `source.rpcId` 必须给：官方 session.prompt 用它做 UI 去重/装配，缺了会话在 DSH
* 对话视图里会报 "received more than one start Match"（实测）。
* @param prompt - 本轮用户消息文本。
* @returns 可直接交给 `agent.followup` 的消息对象。
*/
function createUserMessage(prompt) {
	return Object.freeze({
		id: randomUUID(),
		role: "user",
		content: Object.freeze([Object.freeze({
			type: "text",
			text: prompt
		})]),
		source: Object.freeze({
			kind: "user",
			rpcId: randomUUID()
		})
	});
}
/** 把值以 lossless JSON 写进响应；响应已结束则静默丢弃。 */
function makeSink(res) {
	return { send(payload) {
		if (res.writableEnded === true) return;
		res.write(`data: ${JSON.stringify(payload)}\n\n`);
	} };
}
/** 读满请求体（上限 1 MiB，防御性上限，真正的长度校验在正文里）。 */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.byteLength;
		if (size > 1048576) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** 读取 `{ action, text, ... }` 请求体。 */
async function parseRunRequest(req) {
	const raw = await readBody(req);
	const parsed = JSON.parse(raw === "" ? "{}" : raw);
	const action = parsed.action === "translate" ? "translate" : parsed.action === "summarize" ? "summarize" : parsed.action === "explain" ? "explain" : void 0;
	if (action === void 0) throw new Error("action must be \"translate\", \"explain\" or \"summarize\"");
	const text = typeof parsed.text === "string" ? parsed.text : "";
	if (text.trim() === "") throw new Error("text is empty");
	if (text.length > 12e3) throw new Error(`text is longer than ${MAX_SELECTION_LENGTH} characters`);
	const locale = parsed.locale === "en" ? "en" : "zh";
	const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
	return {
		action,
		text,
		locale,
		...context === "" ? {} : { context: context.slice(0, MAX_CONTEXT_LENGTH) },
		...typeof parsed.cwd === "string" && parsed.cwd !== "" ? { cwd: parsed.cwd } : {},
		...typeof parsed.provider === "string" && parsed.provider !== "" ? { provider: parsed.provider } : {},
		...typeof parsed.model === "string" && parsed.model !== "" ? { model: parsed.model } : {},
		...typeof parsed.target === "string" && parsed.target !== "" ? { target: parsed.target } : {},
		...parsed.engine === "direct" || parsed.engine === "agent" ? { engine: parsed.engine } : {}
	};
}
/**
* 决定这条 agent 用的模型 route：优先跟随当前 DSH 会话的模型，
* 否则用部署默认（`ctx.agentDefaultModel`），再否则交给 agent loop 自己的默认。
*/
function resolveAgentOptions(ctx, request, settings) {
	const seat = request.action === "translate" ? settings.translateModel : request.action === "summarize" ? settings.summarizeModel : settings.explainModel;
	if (seat !== null) return {
		provider: seat.provider,
		model: seat.model,
		...seat.reasoningEffort === void 0 ? {} : { reasoningEffort: seat.reasoningEffort }
	};
	if (request.provider !== void 0 && request.model !== void 0) return {
		provider: request.provider,
		model: request.model
	};
	return defaultAgentOptions(ctx);
}
/** 部署默认模型 route（agentDefaultModel 服务缺席时返回 undefined）。 */
function defaultAgentOptions(ctx) {
	try {
		const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.();
		if (typeof selection?.provider === "string" && typeof selection.model === "string") return {
			provider: selection.provider,
			model: selection.model
		};
	} catch {}
}
/**
* 每次划词都用一条**全新会话**：
* - 与 DSH 里"新开一个对话"一致——上下文干净，回答不会被历史轮次带跑
*   （复用一条会话时实测模型会开始评论"同一段文本这是第四次了"）；
* - 会话**不归档**，跑完留在侧栏的「未分组」里，随时能翻出来继续问。
*
* 会话仍带上当前会话的 cwd（agent 没有工作目录会静默无输出），但不会被挂进
* 任何项目分组——`meta` 里不写 workspaceId，宿主就不会自动 attach；
* 万一被别处挂上了，ensureUngrouped() 会再把它摘下来。
*/
async function ensureAgent(ctx, cwd, request, settings) {
	const agentOptions = resolveAgentOptions(ctx, request, settings);
	const effectiveCwd = cwd ?? process.cwd();
	const sessionId = `session-${randomUUID()}`;
	const handle = await ctx.agents.create({
		sessionId,
		meta: { cwd: effectiveCwd },
		...agentOptions === void 0 ? {} : { agentOptions }
	});
	await ensureUngrouped(ctx, sessionId);
	return handle;
}
/** 串行执行同一 handle 上的一轮对话。 */
function enqueue(sessionId, job) {
	const next = (queues.get(sessionId) ?? Promise.resolve()).then(job, job);
	queues.set(sessionId, next.then(() => void 0, () => void 0));
	return next;
}
/** 从本轮起点向后找最后一条 assistant 消息的文本（服务端权威结果）。 */
function lastAssistantText(session, fromSeq) {
	const end = Number(session.seq ?? 0);
	for (let seq = end - 1; seq >= fromSeq; seq -= 1) {
		let event;
		try {
			event = session.eventAt(seq);
		} catch {
			continue;
		}
		if (event?.type !== "assistant/message") continue;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) continue;
		const text = content.filter((block) => {
			const candidate = block;
			return candidate?.type === "text" && typeof candidate.text === "string";
		}).map((block) => block.text).join("");
		if (text.trim() !== "") return text;
	}
	return "";
}
/**
* 决定这条请求打到哪个模型：设置里的座位 > 请求自带的 route > 部署默认。
* 与 agent 路径共用同一套优先级（resolveAgentOptions）。
*/
function resolveDirectCall(ctx, request, settings) {
	const seat = request.action === "translate" ? settings.translateModel : request.action === "summarize" ? settings.summarizeModel : settings.explainModel;
	if (seat !== null) return {
		provider: seat.provider,
		model: seat.model,
		...seat.reasoningEffort === void 0 ? {} : { reasoningEffort: seat.reasoningEffort }
	};
	if (request.provider !== void 0 && request.model !== void 0) return {
		provider: request.provider,
		model: request.model
	};
	return defaultAgentOptions(ctx);
}
/**
* 直连引擎的模型链：本轮配置的模型打头，后面跟同一 provider 下"别的动作座位"用过的模型。
*
* 座位是用户自己挑的（翻译/解释常选轻模型，总结选另一个），上游过载时它们不一定挤在
* 同一个节点上；换一个座位模型既不用额外配置，也不至于退回一个明显更弱的模型。
* 只收同一 provider 的座位——跨 provider 换会换掉计费与行为，不能替用户做主。
* @param settings - 插件设置。
* @param call - 本轮解析出来的目标模型。
* @returns 按优先级排好的尝试链（至少一项）。
*/
function resolveModelChain(settings, call) {
	const chain = [{
		provider: call.provider,
		model: call.model,
		...call.reasoningEffort === void 0 ? {} : { reasoningEffort: call.reasoningEffort }
	}];
	for (const seat of [settings.translateModel, settings.explainModel, settings.summarizeModel]) {
		if (seat === null || seat === void 0 || seat.provider !== call.provider) continue;
		if (chain.some((entry) => entry.model === seat.model)) continue;
		chain.push({
			provider: seat.provider,
			model: seat.model,
			...seat.reasoningEffort === void 0 ? {} : { reasoningEffort: seat.reasoningEffort }
		});
	}
	// 最后一道：跨 provider 的兜底模型（受设置页开关控制；选中文字会被发给那家服务）。
	const fallback = settings.fallbackModel;
	if (settings.crossProviderFallback !== false && fallback !== null && fallback !== void 0) {
		if (!chain.some((entry) => entry.provider === fallback.provider && entry.model === fallback.model)) {
			chain.push({
				provider: fallback.provider,
				model: fallback.model,
				...fallback.reasoningEffort === void 0 ? {} : { reasoningEffort: fallback.reasoningEffort }
			});
		}
	}
	return chain;
}
/**
* 用 DSH 内置的 translator 服务做一次机译（Bing / Google 的匿名浏览器端点）。
*
* 只在「翻译」动作下尝试；服务缺席（没启用那个组件）、设置选了 llm、文本超过
* 服务的单次上限或调用失败时返回 null，交给 LLM 链路接手——机译是加速带，
* 不是唯一通道，所以任何异常都不该让浮窗报错。
*
* @param ctx - 宿主上下文（`translator` 是别的插件提供的可选服务）。
* @param args - 已校验的划词请求。
* @param settings - 当前设置。
* @param signal - 本轮的中止信号（`/stop` 用）。
* @returns 译文；没走或失败时 null。
*/
const MT_ATTEMPT_TIMEOUT_MS = 5e3;
/** 一次机译最多尝试几次（匿名端点偶发挂起，重试一次通常就恢复）。 */
const MT_ATTEMPTS = 2;
/**
 * 翻译优先走匿名机译：免登录、不走模型、首字更快。
 *
 * 内置 translator 服务自身的超时是 10s 且不重试，而 Bing 匿名端点偶发长时间不响应，
 * 一次抖动就会让用户看到「生成失败」。这里给每次尝试 5s 超时并最多试两次，
 * 失败/超长/服务缺席时返回 null，由调用方回落到模型链路。
 */
async function machineTranslate(ctx, args, settings, signal) {
	const engine = settings.translateEngine;
	if (engine !== "bing" && engine !== "google") return null;
	let service;
	try {
		service = ctx.get?.("translator") ?? ctx.root?.get?.("translator");
	} catch {
		return null;
	}
	if (service === void 0 || service === null) return null;
	if (typeof service.resolve !== "function" || typeof service.translate !== "function") return null;
	const limit = typeof service.maxTextChars === "number" ? service.maxTextChars : 4e3;
	if (args.text.length > limit) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: selection is ${args.text.length} chars, longer than machine translation limit ${limit}; using the model`);
		return null;
	}
	const targetLanguage = mtTargetLanguage(args.text, settings);
	for (let attempt = 1; attempt <= MT_ATTEMPTS; attempt += 1) {
		if (signal?.aborted === true) return null;
		const attemptController = new AbortController();
		const timer = setTimeout(() => attemptController.abort(new Error(`machine translation timed out after ${MT_ATTEMPT_TIMEOUT_MS}ms`)), MT_ATTEMPT_TIMEOUT_MS);
		const relay = () => attemptController.abort(signal?.reason);
		signal?.addEventListener?.("abort", relay);
		try {
			const spec = service.resolve({
				text: args.text,
				sourceLanguage: "auto",
				targetLanguage,
				provider: engine
			});
			const translated = await service.translate(spec, attemptController.signal);
			if (typeof translated === "string" && translated.trim() !== "") return translated.trim();
			ctx.logger?.warn?.(`${PLUGIN_ID}: machine translation via ${engine} returned empty text (attempt ${attempt}/${MT_ATTEMPTS})`);
		} catch (error) {
			if (signal?.aborted === true) return null;
			ctx.logger?.warn?.(`${PLUGIN_ID}: machine translation via ${engine} failed (attempt ${attempt}/${MT_ATTEMPTS})`, error);
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", relay);
		}
	}
	return null;
}
/**
* 快路径：不建会话、不进 agent loop，直接调一次模型并把增量推下去。
*
* 这是与 agent 路径的**行为差异**所在：没有系统提示、没有工具、没有 DSH 会话记录，
* 因此不能在侧栏里接着追问——换来的是首字延迟从"整轮跑完"降到"模型吐第一个字"。
*
* @param ctx - 宿主上下文（用它的 `llm` 服务）。
* @param sink - SSE 写出面。
* @param args - 已校验的划词请求。
*/
async function runDirect(ctx, sink, args) {
	const settings = loadSettings();
	const locale = args.locale ?? "zh";
	const runId = `run-${randomUUID()}`;
	const controller = new AbortController();
	runs.set(runId, controller);
	sink.send({
		type: "session",
		sessionId: runId
	});
	/**
	* 翻译优先走机译：匿名端点免登录、不走模型、首字更快。
	* 失败/超长/服务缺席时 machineTranslate 返回 null，下面的 LLM 链路照旧接手。
	*/
	if (args.action === "translate") {
		const translated = await machineTranslate(ctx, args, settings, controller.signal);
		if (controller.signal.aborted === true) {
			runs.delete(runId);
			throw new Error("stopped");
		}
		if (translated !== null) {
			runs.delete(runId);
			sink.send({
				type: "delta",
				text: translated
			});
			sink.send({
				type: "done",
				sessionId: runId,
				text: translated,
				via: settings.translateEngine
			});
			return;
		}
	}
	const llm = ctx.get?.("llm");
	if (llm === void 0 || llm === null || typeof llm.stream !== "function") throw new Error("llm service is unavailable");
	const call = resolveDirectCall(ctx, args, settings);
	if (call === void 0) throw new Error("no model route: set one in the plugin settings or in the current session");
	const target = args.target ?? resolveTarget(args.text, settings, locale);
	const rules = args.action === "translate" ? settings.translateRules : args.action === "summarize" ? settings.summarizeRules : settings.explainRules;
	const prompt = buildPrompt(args.action, args.text, target, locale, args.context ?? "", rules);
	let text = "";
	/** 最后一次失败的原文（所有尝试都失败时抛它）。 */
	let failure = "";
	let total = 0;
	try {
		/**
		 * 试一轮：把增量推给浮窗，返回失败原文（成功返回空串）。
		 * @param target - 这一次打到哪个模型。
		 */
		const attemptStream = async (target) => {
			/**
			 * 这一次尝试自己的中止开关：`/stop` 或"空闲超时"都能掐掉它，
			 * 又不会把整条 run 一起废掉——那样后面的模型就没法接手重试了。
			 */
			const attempt = new AbortController();
			const abortAttempt = () => attempt.abort();
			controller.signal.addEventListener("abort", abortAttempt);
			let idleTimer = null;
			let idleFired = false;
			/**
			 * 每收到一个 chunk 就把空闲计时器往后推；到点还没动静就掐掉这次尝试。
			 * 上游过载时最常见的坏法不是报错，而是把连接挂着不回——没有这道闸，
			 * 浮窗会一直转圈，重试逻辑也永远不会触发。
			 */
			const armIdle = () => {
				if (idleTimer !== null) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					idleFired = true;
					attempt.abort();
				}, DIRECT_IDLE_MS);
				idleTimer.unref?.();
			};
			try {
				armIdle();
				const options = {
					provider: target.provider,
					model: target.model,
					sessionId: runId,
					...target.reasoningEffort === void 0 ? {} : { reasoningEffort: target.reasoningEffort },
					messages: [{
						role: "user",
						content: [{
							type: "text",
							text: prompt
						}]
					}],
					signal: attempt.signal
				};
				let failed = "";
				for await (const chunk of llm.stream(options)) {
					armIdle();
					if (chunk === null || typeof chunk !== "object") continue;
					if (chunk.type === "text-delta" && typeof chunk.text === "string") {
						text += chunk.text;
						sink.send({
							type: "delta",
							text: chunk.text
						});
						continue;
					}
					if (chunk.type !== "finish") continue;
					const kind = chunk.reason?.kind;
					if (kind === "error" || kind === "aborted") {
						const reason = chunk.reason?.failure;
						failed = typeof reason?.message === "string" && reason.message !== "" ? reason.message : "model call failed";
						break;
					}
				}
				// 被空闲闸掐掉的流不一定还会给 finish 块，这里补一条能让 isTransientFailure 认出来的原因。
				if (failed === "" && idleFired) failed = `upstream stream idle > ${Math.round(DIRECT_IDLE_MS / 1e3)}s (timed out)`;
				return failed;
			} finally {
				if (idleTimer !== null) clearTimeout(idleTimer);
				controller.signal.removeEventListener("abort", abortAttempt);
			}
		};
		/**
		 * 上游过载是常态性的瞬时错误（`429 [overloaded]`）：走 agent 通道的那条路
		 * 有 dsh-llm-retry 兜着，直连这条路没有，所以这里自己重试。
		 *
		 * 两层重试：先在本轮配置的模型上重试，仍被过载挡住就换到同一 provider 下
		 * 别的动作座位用过的模型（通常更轻、更不容易被打满）。只在"一个字都还没
		 * 吐出去"时重试——已经推给浮窗的内容再重来一遍，用户会看到同一段话重复。
		 */
		const chain = resolveModelChain(settings, call);
		let index = 0;
		let triesForModel = 0;
		while (index < chain.length && total < DIRECT_MAX_ATTEMPTS) {
			total += 1;
			triesForModel += 1;
			/** 这一次真正打出去的模型：日志/SSE 必须报它，而不是循环里已经挪过位的下一个。 */
			const failedModel = chain[index].model;
			const failed = await attemptStream(chain[index]);
			if (failed === "") break;
			failure = failed;
			if (text !== "") break;
			if (!isTransientFailure(failed)) break;
			// 打头那个模型多给一次机会（一下子的抖动不该换模型），后面的各试一次就往下走；
			// 配额/资格类错误连这一次都不给——重试只会给上游的限流 hold 续命。
			const budget = index === 0 && !isQuotaExhausted(failed) ? DIRECT_TRIES_PER_MODEL : 1;
			const switchModel = triesForModel >= budget && index + 1 < chain.length;
			if (!switchModel && triesForModel >= budget) break;
			if (switchModel) {
				index += 1;
				triesForModel = 0;
			}
			const nextModel = chain[index].model;
			ctx.logger?.warn?.(`${PLUGIN_ID}: "${failedModel}" is overloaded, retrying (${total}/${DIRECT_MAX_ATTEMPTS})${switchModel ? ` on ${nextModel}` : ""}`, failed);
			sink.send({
				type: "retry",
				attempt: total,
				model: failedModel,
				...switchModel ? {
					switched: true,
					nextModel
				} : {},
				message: failed
			});
			await sleep(switchModel ? 120 : 500 * 2 ** (total - 1));
		}
	} finally {
		runs.delete(runId);
	}
	if (failure !== "" && text.trim() === "") {
		const tried = isTransientFailure(failure) && total > 1 ? `（已尝试 ${total} 次）` : "";
		throw new Error(`${failure}${tried}`);
	}
	if (text.trim() === "") throw new Error("model produced no text output");
	sink.send({
		type: "done",
		sessionId: runId,
		text,
		via: "llm"
	});
}
/** 跑一轮：把 agent 的 assistant 文本增量以 SSE 推给调用方。 */
async function runTurn(ctx, sink, args) {
	const settings = loadSettings();
	const agent = (await ensureAgent(ctx, args.cwd, args, settings)).agent;
	const session = agent.session;
	if (session === void 0) throw new Error("agent has no session");
	const sessionId = session.id;
	sink.send({
		type: "session",
		sessionId
	});
	const fromSeq = Number(session.seq ?? 0);
	const locale = args.locale ?? "zh";
	const target = args.target ?? resolveTarget(args.text, settings, locale);
	const rules = args.action === "translate" ? settings.translateRules : args.action === "summarize" ? settings.summarizeRules : settings.explainRules;
	const prompt = buildPrompt(args.action, args.text, target, locale, args.context ?? "", rules);
	/** 本轮事件轨迹（诊断用：失败时能看出卡在哪一步）。 */
	const trace = [];
	/** agent 自己上报的失败（agent/error）；kick() 会把异常吞掉，只能从这里拿到原因。 */
	let agentFailure;
	const offAgentError = listenAgentError(agent, (message) => {
		agentFailure = message;
	});
	const off = ctx.on("session/event", (eventSession, event) => {
		if (eventSession !== session) return;
		if (typeof event?.type === "string") {
			trace.push(event.type);
			if (trace.length > 24) trace.shift();
		}
		if (event?.type !== "assistant/chunk") return;
		const chunk = event.data?.chunk;
		if (chunk?.type === "text-delta" && typeof chunk.text === "string") sink.send({
			type: "delta",
			text: chunk.text
		});
	});
	let text = "";
	try {
		await enqueue(sessionId, async () => {
			agent.followup(createUserMessage(prompt));
			await agent.whenIdle();
		});
		text = lastAssistantText(session, fromSeq);
		await flushSession(ctx, session);
	} finally {
		off();
		offAgentError();
	}
	if (text.trim() === "") {
		const reason = agentFailure ?? `agent produced no assistant text (events: ${trace.join(", ") || "none"})`;
		throw new Error(reason);
	}
	sink.send({
		type: "done",
		sessionId,
		text
	});
}
/**
* 让这条会话留在侧栏的「未分组」里（best-effort）。
*
* 侧栏的分组规则是：归档集合里的会话在所有视图里都不显示；剩下的会话按"是否被
* 某个项目（workspace）记账"分到项目下或「未分组」。所以本插件**不调用
* archiveSession**，只在确实被挂到项目上时把它摘出来（detach），保证落点是「未分组」
* 而不是某个项目——插件的划词记录是即用即走的一次性对话，不该混进用户的工程分组。
*
* @returns 实际落点，仅用于日志/诊断。
*/
async function ensureUngrouped(ctx, sessionId) {
	try {
		const registry = ctx.get?.("workspaceRegistry");
		if (registry === void 0 || registry === null) return "unknown";
		const workspaces = typeof registry.list === "function" ? registry.list() ?? [] : [];
		for (const workspace of workspaces) {
			const ids = workspace?.sessionIds;
			if (!Array.isArray(ids) || !ids.includes(sessionId)) continue;
			if (typeof workspace?.detachSession !== "function") return "unknown";
			await workspace.detachSession(sessionId);
			return "detached";
		}
		return "ungrouped";
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: keeping ${sessionId} ungrouped failed`, error);
		return "unknown";
	}
}
/** 等一轮持久化落盘（服务缺席或失败都不影响本轮作答）。 */
async function flushSession(ctx, session) {
	try {
		await ctx.get?.("sessions")?.flush?.(session);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: session flush failed`, error);
	}
}
/** 订阅 agent 自己的失败上报；事件缺席或上下文不可用时安静跳过。 */
function listenAgentError(agent, report) {
	try {
		const agentCtx = agent.ctx;
		if (typeof agentCtx?.on !== "function") return () => {};
		return agentCtx.on("agent/error", (payload) => {
			const message = payload?.error?.message ?? payload?.message;
			report(typeof message === "string" && message !== "" ? message : "agent reported an error");
		});
	} catch {
		return () => {};
	}
}
/** 停止一轮：直连请求走 AbortController，agent 请求走 agent.cancel。 */
function stopTurn(ctx, sessionId) {
	if (sessionId === void 0) return false;
	const direct = runs.get(sessionId);
	if (direct !== void 0) {
		direct.abort();
		return true;
	}
	const agent = ctx.agents.get?.(sessionId);
	if (agent?.cancel === void 0) return false;
	agent.cancel({ kind: "user" }, { keepInbox: true });
	return true;
}
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}
/**
* 本机地址白名单：插件的接口只该被"这个 DSH 自己"调用。
*
* 插件的路由走 `webServer.register({ kind: "prefix" })`，绕开了 DSH 自带的
* token 校验（核心接口无 token 会给 401），所以鉴权得自己补：
* 1. 浏览器发起的跨站请求一定带 `Origin`（fetch 与表单 POST 都带），不是本机
*    地址就一律拒绝——恶意网页拿不到我们的接口；
* 2. 写请求只认 `Content-Type: application/json`。跨站的"简单请求"只能发
*    text/plain / urlencoded，浏览器不会为它发预检，所以我们把不合法类型挡掉，
*    等于把 CSRF 的另一条路也堵上；
* 3. 不带 `Origin` 的请求放行：curl / 脚本 / 伴生进程本来就不带，也不构成 CSRF。
*/
const LOCAL_ORIGIN_HOSTS = new Set([
	"127.0.0.1",
	"localhost",
	"[::1]",
	"::1"
]);
/**
* 判断请求来源是否本机。
* @param origin - `Origin` 头（可能为空）。
* @returns 是否放行。
*/
function isAllowedOrigin(origin) {
	if (typeof origin !== "string" || origin === "") return true;
	try {
		const parsed = new URL(origin);
		return (parsed.protocol === "http:" || parsed.protocol === "https:") && LOCAL_ORIGIN_HOSTS.has(parsed.hostname);
	} catch {
		return false;
	}
}
/**
* 判断是不是 JSON 写请求。
* @param req - 原始请求。
* @returns 是否 `application/json`。
*/
function isJsonRequest(req) {
	const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
	return type === "application/json";
}
/**
* 系统级浮层 → 会话窗口的「引用」信箱。
*
* 伴生进程跑在独立进程里，碰不到 DSH 页面；它只把"用户想把这段文字拿去问"投进这里，
* 由页面里的客户端半边（轮询 /handoff）取走，开一条新会话并把原文引用进输入框。
* 信箱只在宿主内存里，容量很小：这是即取即用的过路件，不是存储。
*/
const handoffs = [];
/** 信箱序号（单调递增；客户端用它做游标，取到哪一条了）。 */
let handoffSeq = 0;
/** 信箱最多留几条（客户端长时间不在也不会一直涨）。 */
const MAX_HANDOFFS = 20;
/** 客户端长轮询的上限（毫秒）：到点先回空，让客户端自己续下一轮。 */
const HANDOFF_POLL_MS = 20000;
/**
* 客户端角色 → 最近一次来取件的时间。
*
* 桌面端与浏览器标签可能同时开着，两个客户端各有自己的 `since` 游标。只按游标
* 过滤的话同一条「问问」会被投两次（页面开两个会话、引用进两个输入框）。所以
* 取件改成"抢单"：谁先取到就归谁，服务端记 `claimed`。
* 另外"当前会话"只有桌面端才有意义，桌面端在场时让它优先。
*/
const handoffPollers = new Map();
/** 超过这么久没见桌面端来取件，就当它不在场，浏览器端可以接手。 */
const HANDOFF_DESKTOP_GRACE_MS = 15000;
/** 睡一会儿（长轮询用）。 */
function sleep(ms) {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}
/** 收一条引用请求（系统级浮层点「问问」时调用）。 */
function pushHandoff(payload) {
	const text = typeof payload?.text === "string" ? payload.text : "";
	if (text.trim() === "") throw new Error("text is empty");
	handoffSeq += 1;
	// mode：`current` = 落进**当前会话**的输入框（在 DSH 里划的词）；
	// 缺省 `new` = 开一条新会话（在别的应用里划的词）。
	const mode = payload?.mode === "current" ? "current" : "new";
	// 是否附带上文由设置决定（默认开）。关掉时这里就直接不留 context，
	// 页面拿到的条目与旧版完全一致，不需要页面再判断一次。
	const carryContext = loadSettings().askIncludeContext !== false;
	const entry = {
		id: handoffSeq,
		text: text.slice(0, MAX_SELECTION_LENGTH),
		mode,
		...carryContext && typeof payload?.context === "string" && payload.context.trim() !== "" ? { context: payload.context.trim().slice(0, MAX_CONTEXT_LENGTH) } : {},
		at: Date.now(),
		/** 已经投给某个客户端了（抢单式投递，防止双客户端重复引用）。 */
		claimed: false
	};
	handoffs.push(entry);
	while (handoffs.length > MAX_HANDOFFS) handoffs.shift();
	return entry;
}
/** 路由总入口。 */
async function handleRequest(ctx, req, res, companion) {
	const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
	// 来源闸：所有路由都查（GET 也算——跨站的 GET 能改写"取件"状态）。
	if (!isAllowedOrigin(req.headers.origin)) {
		writeJson(res, 403, {
			ok: false,
			message: "forbidden origin"
		});
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/ping`) {
		writeJson(res, 200, {
			ok: true,
			plugin: PLUGIN_ID
		});
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/system/status`) {
		writeJson(res, 200, {
			ok: true,
			/**
			 * 桌面壳（Electron 主进程）的 pid：窗口都归它。伴生进程自己看不到这一层
			 * （它的父进程是 harness 宿主），要靠这里转一手来判断"这次划词是不是
			 * 发生在 DSH 自己的窗口里"。
			 */
			desktopPid: process.ppid,
			companion: companion.status()
		});
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/system/restart`) {
		await companion.restart();
		writeJson(res, 200, {
			ok: true,
			companion: companion.status()
		});
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/settings`) {
		const method = String(req.method ?? "GET").toUpperCase();
		try {
			if (method === "GET") {
				writeJson(res, 200, {
					ok: true,
					settings: loadSettings(),
					defaults: { ...DEFAULT_SETTINGS },
					languages: LANGUAGES,
					path: settingsFilePath()
				});
				return;
			}
			if (method === "POST") {
				if (!isJsonRequest(req)) {
					writeJson(res, 415, {
						ok: false,
						message: "content-type must be application/json"
					});
					return;
				}
				const raw = await readBody(req);
				const next = saveSettings(JSON.parse(raw === "" ? "{}" : raw));
				ctx.logger?.info?.(`${PLUGIN_ID}: settings updated`);
				writeJson(res, 200, {
					ok: true,
					settings: next,
					defaults: { ...DEFAULT_SETTINGS },
					languages: LANGUAGES,
					path: settingsFilePath()
				});
				return;
			}
			writeJson(res, 405, {
				ok: false,
				message: "use GET or POST"
			});
		} catch (error) {
			writeJson(res, 400, {
				ok: false,
				message: error instanceof Error ? error.message : String(error)
			});
		}
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/stop`) {
		if (!isJsonRequest(req)) {
			writeJson(res, 415, {
				ok: false,
				message: "content-type must be application/json"
			});
			return;
		}
		try {
			const raw = await readBody(req);
			const parsed = JSON.parse(raw === "" ? "{}" : raw);
			writeJson(res, 200, { ok: stopTurn(ctx, typeof parsed.sessionId === "string" ? parsed.sessionId : void 0) });
		} catch (error) {
			writeJson(res, 400, {
				ok: false,
				message: error instanceof Error ? error.message : String(error)
			});
		}
		return;
	}
	if (url.pathname === `/api/dsh-select-assist/handoff`) {
		const method = String(req.method ?? "GET").toUpperCase();
		if (method === "POST") {
			if (!isJsonRequest(req)) {
				writeJson(res, 415, {
					ok: false,
					message: "content-type must be application/json"
				});
				return;
			}
			try {
				const raw = await readBody(req);
				const entry = pushHandoff(JSON.parse(raw === "" ? "{}" : raw));
				writeJson(res, 200, {
					ok: true,
					id: entry.id
				});
			} catch (error) {
				writeJson(res, 400, {
					ok: false,
					message: error instanceof Error ? error.message : String(error)
				});
			}
			return;
		}
		if (method !== "GET") {
			writeJson(res, 405, {
				ok: false,
				message: "use GET or POST"
			});
			return;
		}
		/** 长轮询：等到有新的引用请求就回，否则最多挂 HANDOFF_POLL_MS。 */
		const rawSince = url.searchParams.get("since");
		if (rawSince === null) {
			// 不带 since = 只问"现在取到哪儿了"：页面刚加载时用它对齐游标，
			// 免得把上一次刷新之前的旧引用当成新请求弹出来。
			writeJson(res, 200, {
				ok: true,
				items: [],
				cursor: handoffSeq
			});
			return;
		}
		const cursor = Number(rawSince);
		const since = Number.isFinite(cursor) ? cursor : 0;
		const deadline = Date.now() + HANDOFF_POLL_MS;
		// 谁在取件：桌面端（`window.dshDesktop` 存在）还是浏览器标签。
		const role = url.searchParams.get("client") === "desktop" ? "desktop" : "web";
		handoffPollers.set(role, Date.now());
		/**
		 * 取走所有还没被认领的条目（并按 id 推进游标）。
		 * @returns 取到的条目（已剥掉内部字段）。
		 */
		const take = () => {
			const items = handoffs.filter((item) => item.id > since && item.claimed !== true);
			if (items.length === 0) return [];
			for (const item of items) item.claimed = true;
			return items.map((item) => ({
				id: item.id,
				text: item.text,
				mode: item.mode,
				...item.context === void 0 ? {} : { context: item.context },
				at: item.at
			}));
		};
		try {
			for (;;) {
				handoffPollers.set(role, Date.now());
				// 桌面端在场时让它先取：「当前会话」只有桌面端有；顺带避免同一台机器上
				// 桌面端与浏览器标签各投一次。
				const desktopSeenAt = handoffPollers.get("desktop") ?? 0;
				const yieldToDesktop = role !== "desktop" && Date.now() - desktopSeenAt < HANDOFF_DESKTOP_GRACE_MS;
				const items = yieldToDesktop ? [] : take();
				if (items.length > 0) {
					writeJson(res, 200, {
						ok: true,
						items,
						cursor: items[items.length - 1].id
					});
					return;
				}
				if (Date.now() >= deadline || res.destroyed === true || res.writableEnded === true) {
					writeJson(res, 200, {
						ok: true,
						items: [],
						cursor: since
					});
					return;
				}
				await sleep(200);
			}
		} catch {
			if (res.writableEnded !== true) {
				try {
					writeJson(res, 200, {
						ok: true,
						items: [],
						cursor: since
					});
				} catch {}
			}
		}
		return;
	}
	if (url.pathname !== `/api/dsh-select-assist/run`) {
		writeJson(res, 404, {
			ok: false,
			message: "not found"
		});
		return;
	}
	if (String(req.method ?? "GET").toUpperCase() !== "POST") {
		writeJson(res, 405, {
			ok: false,
			message: "use POST"
		});
		return;
	}
	if (!isJsonRequest(req)) {
		writeJson(res, 415, {
			ok: false,
			message: "content-type must be application/json"
		});
		return;
	}
	let args;
	try {
		args = await parseRunRequest(req);
	} catch (error) {
		writeJson(res, 400, {
			ok: false,
			message: error instanceof Error ? error.message : String(error)
		});
		return;
	}
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive"
	});
	const sink = makeSink(res);
	try {
		if ((args.engine ?? loadSettings().engine) === "agent") await runTurn(ctx, sink, args);
		else await runDirect(ctx, sink, args);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_ID}: run failed`, error);
		sink.send({
			type: "error",
			message: error instanceof Error ? error.message : String(error)
		});
	} finally {
		res.end();
	}
}
/**
* 挂载插件：注册同源路由，plugin unload 时随之摘除。
* @param ctx - 宿主 Cordis 上下文。
*/
function apply(ctx) {
	const companion = createCompanionManager(ctx, { enabled: process.env.DSH_SELECTION_DISABLE_SYSTEM !== "1" });
	companion.install();
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: (req, res) => {
			handleRequest(ctx, req, res, companion).catch((error) => {
				ctx.logger?.warn?.(`${PLUGIN_ID}: route failure`, error);
				if (res.headersSent !== true) writeJson(res, 500, {
					ok: false,
					message: "internal error"
				});
				else if (res.writableEnded !== true) res.end();
			});
		}
	}), `${PLUGIN_ID}: routes`);
}
//#endregion
export { apply, inject, name };
