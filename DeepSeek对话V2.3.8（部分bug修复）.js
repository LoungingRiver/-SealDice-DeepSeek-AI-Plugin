// ==UserScript==
// @name         Deepseek AI Plugin
// @author       懒河
// @version      2.3.8
// @description  在保证了数据兼容性的情况下新增思考模式与强度控制，模型升级至deepseek-v4-flash，需老版本用户对插件进行更新时手动更新大模型名称，亦可使用deepseek-v4-pro，相较而言更推荐快捷且经济的前者deepseek-v4-flash，而后者更能适应复杂的需要，但是更烧钱。根据海豹1.6.0更新调整了配置项界面，同时1.6.0以下版本仍可继续使用该插件。增设多个关键词配置选项。整合了随机插话，加入了独立的插话摘要，且在私聊中读取个人对话上下文数据+个人对话摘要+群里插话摘要，在群聊中读取群聊上下文数据+插话对话摘要+个人对话摘要，以保证更好的使用体验。V2.3.1 将随机插话改为「总开关控制模块启停 + 指令按群聊分别控制」的双层控制模型。V2.3.2 修复私聊读取群聊（随机插话）摘要：新增「私聊关联群号」配置与独立的「私聊关联群号开关」（默认开），以及「查看关联群插话摘要」指令；关闭开关时私聊仅回退到该用户最近一次活跃插话群。 V2.3.6 随机插话上下文扩展：随机插话（骰子AI对话）现在能同时读取到群聊中的「指令消息」与「指令执行结果」，让插话AI拥有更完整的上下文；同时指令消息及其结果「不计入」用于触发随机对话的累计条目。V2.3.8 修复随机插话计数竞态导致的偶发不触发/重复触发；随机插话回复与摘要生成的 max_tokens 现与「基础设置」中的配置保持一致。
// @license      MIT
// @timestamp    2026/09/18
// @updateUrl    https://github.com/LoungingRiver/-SealDice-DeepSeek-AI-Plugin/releases/latest/download/deepseek-chat.js
// @sealVersion  1.6.0
// ==/UserScript==

if (!seal.ext.find('deepseekai')) {
    const ext = seal.ext.new('deepseekai', '懒河', '2.3.8');
    seal.ext.register(ext);

    // ==================== 配置注册辅助函数 ====================

    // 兼容读取配置值的工具：统一从 ConfigItem 对象中取出"值"
    function getConfigValue(configKey, fallback) {
        try {
            const cfg = seal.ext.getConfig(ext, configKey);
            if (!cfg) return fallback;
            if ('value' in cfg) {
                const v = cfg.value;
                if (v === undefined || v === null) return fallback;
                return v;
            }
            return cfg;
        } catch (e) { return fallback; }
    }

    function registerStringIfNotExists(configKey, defaultValue, description, group) {
        const existing = seal.ext.getConfig(ext, configKey);
        if (existing !== null && existing !== undefined) {
            try { if (existing.group !== group) { existing.group = group; if (typeof seal.ext.registerConfig === 'function') seal.ext.registerConfig(ext, existing); } } catch (e) {}
            return;
        }
        seal.ext.registerStringConfig(ext, configKey, defaultValue, description, group);
    }

    function registerTemplateIfNotExists(configKey, defaultValue, description, group) {
        const existing = seal.ext.getConfig(ext, configKey);
        if (existing !== null && existing !== undefined) {
            try { if (existing.group !== group) { existing.group = group; if (typeof seal.ext.registerConfig === 'function') seal.ext.registerConfig(ext, existing); } } catch (e) {}
            return;
        }
        seal.ext.registerTemplateConfig(ext, configKey, defaultValue, description, group);
    }

    function registerBoolIfNotExists(configKey, defaultValue, description, group) {
        const existing = seal.ext.getConfig(ext, configKey);
        if (existing !== null && existing !== undefined) {
            if (typeof existing.value === 'string') {
                const oldVal = existing.value;
                let migrated;
                if (oldVal === "enabled" || oldVal === "true") migrated = true;
                else if (oldVal === "disabled" || oldVal === "false") migrated = false;
                if (migrated !== undefined) {
                    try { seal.ext.registerBoolConfig(ext, configKey, migrated, description, group); console.log(`[配置迁移] ${configKey}: "${oldVal}" → ${migrated}（bool）`); } catch (e) {}
                }
            }
            try { const cur = seal.ext.getConfig(ext, configKey); if (cur && cur.group !== group) { cur.group = group; if (typeof seal.ext.registerConfig === 'function') seal.ext.registerConfig(ext, cur); } } catch (e) {}
            return;
        }
        seal.ext.registerBoolConfig(ext, configKey, defaultValue, description, group);
    }

    // 非指令关键词：以 TemplateConfig（数组）注册；旧字符串自动迁移为数组
    function registerKeywordsIfNotExists(configKey, defaultArray, description, group) {
        const existing = seal.ext.getConfig(ext, configKey);
        if (existing !== null && existing !== undefined) {
            if (typeof existing.value === 'string') {
                const oldStr = existing.value;
                try { const arr = oldStr ? [oldStr] : defaultArray; seal.ext.registerTemplateConfig(ext, configKey, arr, description, group); console.log(`[配置迁移] ${configKey}: 字符串"${oldStr}" → 数组${JSON.stringify(arr)}`); } catch (e) {}
            }
            try { const cur = seal.ext.getConfig(ext, configKey); if (cur && cur.group !== group) { cur.group = group; if (typeof seal.ext.registerConfig === 'function') seal.ext.registerConfig(ext, cur); } } catch (e) {}
            return;
        }
        seal.ext.registerTemplateConfig(ext, configKey, defaultArray, description, group);
    }

    function getTriggerKeywords() {
        let raw = getConfigValue("非指令关键词", null);
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) raw = raw.value;
        if (Array.isArray(raw)) return raw.map(String).filter(w => w && w.trim().length > 0);
        if (typeof raw === 'string') return raw.trim() ? [raw] : [];
        return [];
    }

    // ==================== 摘要功能总开关（V2.3.5） ====================
    // 统一入口：判断当前是否启用摘要功能。
    // 关闭时：既不生成/更新摘要，也不把摘要注入系统上下文；但已落盘的旧摘要数据保留不删。
    // 读取类操作（查看摘要等）仍允许访问旧数据，不受此开关限制。
    function isSummaryEnabled() {
        return !!getConfigValue("摘要功能总开关", true);
    }

    // ==================== 私聊关联群号解析（V2.3.2） ====================
    // 受「私聊关联群号开关」控制：开关关闭时返回空数组（仅走最近活跃群回退）。
    // Template 数组形态优先；兼容旧版 String 形态（按换行/逗号/分号拆分）。
    function getLinkedGroupIds() {
        if (!getConfigValue("私聊关联群号开关", true)) return [];
        let raw = getConfigValue("私聊关联群号", null);
        if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw) raw = raw.value;
        const out = [];
        if (Array.isArray(raw)) {
            for (const v of raw) { const s = String(v).trim(); if (s) out.push(s); }
        } else if (typeof raw === 'string' && raw.trim()) {
            for (const part of raw.split(/[\n,，;；]+/)) { const s = part.trim(); if (s) out.push(s); }
        }
        return out;
    }

    // ==================== 注册配置项（按分组） ====================

    // —— 基础设置组 ——
    registerStringIfNotExists("大模型url", "https://api.deepseek.com/v1/chat/completions", "大模型 API 地址", "基础设置");
    registerStringIfNotExists("大模型模型名", "deepseek-v4-flash", "大模型模型名称", "基础设置");
    registerStringIfNotExists("你的APIkeys", "sk-your-api-key-here", "你的 API Key", "基础设置");
    registerStringIfNotExists("最大回复tokens数", "600", "最大回复 tokens 数", "基础设置");
    registerStringIfNotExists("摘要生成最大tokens数", "1000", "摘要生成最大 tokens 数", "基础设置");
    registerStringIfNotExists("存储上下文对话限制轮数", "16", "存储上下文对话限制轮数", "基础设置");
    registerStringIfNotExists("Temperature", "1.3", "Temperature 设置 (0.0-2.0)", "基础设置");
    registerBoolIfNotExists("思考模式开关", true, "思考模式开关（开/关）", "基础设置");
    (function registerReasoningEffort() {
        const key = "思考强度";
        const existing = seal.ext.getConfig(ext, key);
        if (existing !== null && existing !== undefined) {
            try { if (existing.group !== "基础设置") { existing.group = "基础设置"; if (typeof seal.ext.registerConfig === 'function') seal.ext.registerConfig(ext, existing); } } catch (e) {}
            return;
        }
        seal.ext.registerOptionConfig(ext, key, "high", ["high", "max"], "思考强度设置 (high/max)", "基础设置");
    })();

    // —— 个性配置组 ——
    registerStringIfNotExists("角色设定", "你是一只黑猫骰骰娘，主要用于测试，乐于为测试者提供一切需要的服务。在必要时应当回答包括已知的时间信息，摘要内容等相关的提问。", "角色设定（系统提示词）", "个性配置");
    registerKeywordsIfNotExists("非指令关键词", ["小伊"], "触发对话的关键词（每行一个，支持多个）", "个性配置");
    registerStringIfNotExists("摘要生成提示词", "请基于之前的对话摘要和最新的对话内容，更新对话摘要。保留重要信息，添加新内容，确保摘要的连贯性和完整性。", "摘要生成提示词", "个性配置");
    // V2.3.5：摘要功能总开关（Bool，默认开）。
    // 关闭时：停止生成/更新个人对话摘要与群聊插话摘要，且不将任何摘要注入系统上下文；
    // 但已存储的旧摘要数据予以保留（不删除），重新开启后可立即恢复使用，保证旧数据兼容。
    // 默认值为 true，老版本升级用户因配置已存在会走「existing」分支，原值不受影响。
    registerBoolIfNotExists("摘要功能总开关", true, "摘要功能总开关（开/关，默认开）。关闭后不再生成/更新个人对话摘要与群聊插话摘要，也不会将摘要注入系统上下文；已保存的旧摘要数据保留，重新开启即可恢复。", "个性配置");
    const libraryKeys = ["full_library", "sub1_library", "sub2_library", "sub3_library"];
    libraryKeys.forEach((libKey) => {
        const existing = seal.ext.getConfig(ext, libKey);
        if (existing !== null && existing !== undefined) {
            try { if (existing.group !== "个性配置") { existing.group = "个性配置"; if (typeof seal.ext.registerConfig === 'function') seal.ext.registerConfig(ext, existing); } } catch (e) {}
            return;
        }
        seal.ext.registerStringConfig(ext, libKey, "", `${libKey} 长文本资料库内容（支持多行文本）`, "个性配置");
    });

    // —— 权限设置组 ——
    registerBoolIfNotExists("白名单开关", true, "白名单开关（开/关）", "权限设置");
    registerTemplateIfNotExists("允许使用群号", ["QQ-Group:123456", "QQ-Group:654321"], "限制允许接收消息的群号", "权限设置");
    registerTemplateIfNotExists("允许使用私聊", ["QQ:111111", "QQ:222222"], "限制允许接收消息的私聊", "权限设置");

    // —— 随机插话设置组 ——
    // 「总开关」：控制整个随机插话模块是否启用；关闭时所有群聊/私聊均不触发。
    registerBoolIfNotExists("随机插话总开关", false, "随机插话模块总开关（开/关，默认关）。开启后仍需在各群聊中用非指令关键词单独启用。", "随机插话设置");
    // V2.3.2：私聊关联群号开关（Bool，用法同「白名单开关」），控制私聊是否按关联群号列表读取插话摘要
    registerBoolIfNotExists("私聊关联群号开关", true, "私聊关联群号开关（开/关，默认开）。开启后私聊会按「私聊关联群号」列表读取对应群的插话摘要；关闭时忽略关联群号列表，仅回退到该用户最近一次活跃插话群。", "随机插话设置");
    // V2.3.2：私聊关联群号（Template 数组，用法同「允许使用群号」，预填演示群号 QQ-Group:123456）
    registerTemplateIfNotExists("私聊关联群号", ["QQ-Group:123456", "QQ-Group:654321"], "私聊读取群聊插话摘要时关联的群号（每行/每项一个，格式同「允许使用群号」，如 QQ-Group:123456）。需先开启「私聊关联群号开关」。", "随机插话设置");
    registerStringIfNotExists("随机插话每N条触发", "5", "每累计 N 条群消息自动触发一次随机插话", "随机插话设置");
    // V2.3.3：开启/关闭关键词改为非指令关键词触发（群聊内），默认值保持原有文案
    registerStringIfNotExists("随机插话开启关键词", "开启随机插话", "非指令关键词：群聊中发送包含此关键词的普通消息即开启本群随机插话（受「随机插话控制需要高级权限」开关约束，无需「.」前缀）", "随机插话设置");
    registerStringIfNotExists("随机插话关闭关键词", "关闭随机插话", "非指令关键词：群聊中发送包含此关键词的普通消息即关闭本群随机插话（受「随机插话控制需要高级权限」开关约束，无需「.」前缀）", "随机插话设置");
    // V2.3.7：随机插话开启/关闭是否需要高级权限（Bool，默认开）。
    // 开启（默认）：保持原有行为，仅高权限（privilegeLevel ≥ 100）可使用开启/关闭关键词控制随机插话；
    // 关闭：任何人均可通过非指令关键词（无需骰主/高权限）开启或关闭本群随机插话。
    registerBoolIfNotExists("随机插话控制需要高级权限", true, "随机插话中非指令关键词控制开关、随机插话状态、查看插话摘要的指令是否需要高级权限（开/关，默认开）。", "随机插话设置");
    registerStringIfNotExists("随机插话开启回复", "当前会话随机插话已开启", "开启成功回复语", "随机插话设置");
    registerStringIfNotExists("随机插话关闭回复", "当前会话随机插话已关闭", "关闭成功回复语", "随机插话设置");
    registerStringIfNotExists("随机插话强制触发关键词", "强制插话", "包含此关键词的消息强制立即触发一次插话", "随机插话设置");
    registerStringIfNotExists("随机插话群聊上下文轮数", "8", "群聊（插话）上下文保留轮数", "随机插话设置");
    registerStringIfNotExists("随机插话摘要提示词", "请基于之前的群聊插话摘要和最新的群聊插话对话内容，更新群聊插话摘要。保留群聊中的关键信息、话题走向和重要结论，添加新内容，确保摘要的连贯性和完整性。", "随机插话摘要生成提示词（独立于个人对话摘要提示词）", "随机插话设置");

    // ==================== 配置分组迁移 ====================
    function migrateConfigGroups() {
        const groupMap = {
            "大模型url": "基础设置", "大模型模型名": "基础设置", "你的APIkeys": "基础设置",
            "最大回复tokens数": "基础设置", "摘要生成最大tokens数": "基础设置",
            "存储上下文对话限制轮数": "基础设置", "Temperature": "基础设置",
            "思考模式开关": "基础设置", "思考强度": "基础设置",
            "角色设定": "个性配置", "非指令关键词": "个性配置", "摘要生成提示词": "个性配置", "摘要功能总开关": "个性配置",
            "full_library": "个性配置", "sub1_library": "个性配置", "sub2_library": "个性配置", "sub3_library": "个性配置",
            "白名单开关": "权限设置", "允许使用群号": "权限设置", "允许使用私聊": "权限设置",
            "随机插话总开关": "随机插话设置", "私聊关联群号开关": "随机插话设置", "私聊关联群号": "随机插话设置",
            "随机插话每N条触发": "随机插话设置",
            "随机插话开启关键词": "随机插话设置", "随机插话关闭关键词": "随机插话设置",
            "随机插话控制需要高级权限": "随机插话设置",
            "随机插话开启回复": "随机插话设置", "随机插话关闭回复": "随机插话设置",
            "随机插话强制触发关键词": "随机插话设置", "随机插话群聊上下文轮数": "随机插话设置",
            "随机插话摘要提示词": "随机插话设置"
        };
        let migratedCount = 0;
        Object.entries(groupMap).forEach(([key, targetGroup]) => {
            try {
                const cfg = seal.ext.getConfig(ext, key);
                if (cfg && cfg.group !== targetGroup) { cfg.group = targetGroup; if (typeof seal.ext.registerConfig === 'function') seal.ext.registerConfig(ext, cfg); migratedCount++; }
            } catch (e) {}
        });
        if (migratedCount > 0) console.log(`[DeepseekAI] 配置分组迁移完成，共迁移 ${migratedCount} 项`);
    }
    migrateConfigGroups();

    // 旧版「随机插话开关」（全局单开关）向 V2.3.1 双层模型迁移：
    // 若该旧配置存在且为 true，则将其值迁移到新的「随机插话总开关」，并清除旧键。
    (function migrateOldChaosMasterSwitch() {
        try {
            const oldCfg = seal.ext.getConfig(ext, "随机插话开关");
            if (oldCfg !== null && oldCfg !== undefined) {
                let oldVal = false;
                if (typeof oldCfg === 'boolean') oldVal = oldCfg;
                else if (typeof oldCfg.value === 'boolean') oldVal = oldCfg.value;
                else if (typeof oldCfg.value === 'string') oldVal = (oldCfg.value === "enabled" || oldCfg.value === "true");
                if (oldVal) {
                    seal.ext.registerBoolConfig(ext, "随机插话总开关", true, "随机插话模块总开关（开/关，默认关）。开启后仍需在各群聊中用非指令关键词单独启用。", "随机插话设置");
                    console.log("[配置迁移] 旧「随机插话开关」(true) → 新「随机插话总开关」(true)");
                }
                // 移除旧配置键，避免与新总开关并存造成混淆
                if (typeof seal.ext.unregisterConfig === 'function') {
                    try { seal.ext.unregisterConfig(ext, "随机插话开关"); } catch (e) {}
                }
            }
        } catch (e) {}
    })();

    // ==================== 工具函数 ====================
    function getCurrentTimeStamp() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }
    function getTodayUntilNow() { const n = new Date(); return n.getHours()*3600 + n.getMinutes()*60 + n.getSeconds(); }
    function parseMarkdown(text) {
        if (!text) return "";
        text = text.replace(/```(json)?([\s\S]*?)```/g, (m, isJson, c) => `\`\`\`${isJson||''}\n${c}\n\`\`\``);
        text = text.replace(/`([^`]+)`/g, '$1');
        text = text.replace(/!\[.*?\]\(.*?\)/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1');
        text = text.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2');
        text = text.replace(/^#+\s+/gm, '').replace(/^>\s+/gm, '').replace(/^[\*\-\+]\s+/gm, '');
        text = text.replace(/^\|.*?\|$/gm, '').replace(/^[-*_]{3,}$/gm, '').replace(/<[^>]+>/g, '');
        text = text.replace(/\n{3,}/g, '\n\n');
        return text.trim();
    }

    // ==================== DeepseekAI 核心类（个人对话/摘要） ====================
    class DeepseekAI {
        constructor(userId) {
            this.userId = userId;
            this.context = [];
            this.loadContext();
            this.initializeSummarySystem();
        }
        initializeSummarySystem() {
            try {
                // V2.3.5：摘要功能关闭时，不自动生成也不注入摘要，仅确保系统上下文正常即可
                if (!isSummaryEnabled()) { this.updateSystemContext(); return; }
                const summary = this.loadSummary();
                const hasOldData = this.context && this.context.length > 0;
                const hasValidSummary = summary.content && summary.content.trim().length > 0;
                if (hasOldData && !hasValidSummary && this.context.length > 3) this.generateInitialSummarySync();
                else if (hasValidSummary) this.updateSystemContext();
            } catch (e) { console.error(`[摘要系统初始化错误] 用户 ${this.userId}:`, e); }
        }
        generateInitialSummarySync() {
            try {
                const recent = this.context.slice(-4);
                if (recent.length === 0) return;
                let s = "历史对话包含以下内容：";
                const topics = [];
                for (const m of recent) { if (m.role === "user") { const c = m.content.replace(/from .+?\[.+?\]: /, ''); if (c.length > 10) topics.push(c.substring(0,50)+(c.length>50?"...":"")); } }
                if (topics.length > 0) { s += topics.slice(0,3).join("；"); this.saveSummary(s); this.updateSystemContext(); }
            } catch (e) { console.error(`[初始摘要生成错误] 用户 ${this.userId}:`, e); this.saveSummary("开始新的对话"); this.updateSystemContext(); }
        }
        loadSummary() {
            try {
                const newKey = `deepseek_summary_${this.userId}`;
                let saved = ext.storageGet(newKey); let isNew = true;
                if (!saved) { saved = ext.storageGet(`${this.userId}_summary`); if (!saved) saved = ext.storageGet(this.userId); isNew = false; if (saved) console.log(`[摘要迁移] 用户 ${this.userId} 旧格式摘要迁移`); }
                if (saved) {
                    let p; if (typeof saved === 'string') { try { p = JSON.parse(saved); } catch (e) { const sm = {content:saved,lastUpdated:getCurrentTimeStamp(),version:"1.0"}; if(!isNew) ext.storageSet(newKey,JSON.stringify(sm)); return sm; } } else p = saved;
                    if (p && typeof p.content === 'string') { const sm = {content:p.content||"",lastUpdated:p.lastUpdated||getCurrentTimeStamp(),version:p.version||"1.0"}; if(!isNew) ext.storageSet(newKey,JSON.stringify(sm)); return sm; }
                }
            } catch (e) { console.error(`[摘要加载错误] 用户 ${this.userId}:`, e); }
            return { content: "", lastUpdated: getCurrentTimeStamp(), version: "1.0" };
        }
        saveSummary(c) { ext.storageSet(`deepseek_summary_${this.userId}`, JSON.stringify({content:c||"",lastUpdated:getCurrentTimeStamp(),version:"1.0"})); }
        resetSummary() { this.saveSummary(""); this.updateSystemContext(); return "对话摘要已重置"; }
        getTemperature() { const t = parseFloat(getConfigValue("Temperature", "1.3")); return isNaN(t)?1.3:Math.max(0,Math.min(2,t)); }
        updateSystemContext(force=false, currentGroupId) {
            try {
                let sys = getConfigValue("角色设定", "");
                const summary = this.loadSummary();
                const lib = this.getAllLibrariesContent();
                if (lib) sys += `\n\n【资料库信息】\n${lib}\n──────────\n`;
                // V2.3.5：摘要功能关闭时，不将个人对话摘要与关联群聊插话摘要注入系统上下文；旧摘要数据保留
                if (isSummaryEnabled()) {
                    if (summary.content && summary.content.trim().length > 0) sys += `\n\n【先前对话摘要】\n${summary.content}\n──────────\n`;
                    // V2.3.2：注入关联群聊（群聊=当前群；私聊=关联群号列表∪最近活跃群）的插话摘要
                    const linkedBlock = buildLinkedChaosSummaryBlock(this.userId, currentGroupId);
                    if (linkedBlock) sys += `\n\n【关联群聊插话摘要】\n${linkedBlock}\n──────────\n`;
                }
                if (!this.context || !this._validateContext(this.context)) { this._resetConversation(false); return; }
                this._ensureSystemMessage(sys);
                if (force) ext.storageSet(`deepseek_ctx_${this.userId}`, JSON.stringify(this.context));
            } catch (e) { console.error(`[系统上下文更新错误] 用户 ${this.userId}:`, e); }
        }
        _ensureSystemMessage(sys) { if (!this.context||this.context.length===0){this.context=[{role:"system",content:sys}];return;} if(this.context[0]&&this.context[0].role==="system")this.context[0].content=sys;else this.context.unshift({role:"system",content:sys}); }
        _validateContext(d){try{if(!Array.isArray(d))return false;if(d.length===0)return false;return d.every(m=>m&&typeof m==='object'&&m.role&&m.content);}catch(e){return false;}}
        _isOldDataFormat(d){if(!Array.isArray(d))return false;for(const m of d){if(m.role==="user"&&m.content&&m.content.includes('): ')&&!m.content.includes(']'))return true;}return false;}
        _migrateOldData(old){try{if(!Array.isArray(old))return this._createNewConversation();const nc=[];let hs=false;for(const m of old){if(m.role==="system"){hs=true;nc.push(m);}}if(!hs)nc.unshift({role:"system",content:getConfigValue("角色设定","")});for(const m of old){if(m.role!=="system"){if(m.role==="user"&&!m.content.includes('[')){const ts=getCurrentTimeStamp(),td=getTodayUntilNow();nc.push({role:m.role,content:this._addTimestampToOldMessage(m.content,ts,td)});}else nc.push(m);}}return nc;}catch(e){console.error(`[数据迁移错误] 用户 ${this.userId}:`,e);return this._createNewConversation();}}
        _addTimestampToOldMessage(o,t,s){if(o.startsWith('from ')&&o.includes('): ')){const p=o.split('): ');if(p.length===2)return `${p[0]}[${t}|${s}s]: ${p[1]}`;}return `from 系统（QQ:${this.userId}）[${t}|${s}s]: ${o}`;}
        _createNewConversation(){const ts=getCurrentTimeStamp(),td=getTodayUntilNow();return[{role:"system",content:getConfigValue("角色设定","")},{role:"user",content:`from 新用户（QQ:${this.userId}）[${ts}|${td}s]: 你好`},{role:"assistant",content:"准备好啦~"}];}
        _resetConversation(resetSum=false){const ts=getCurrentTimeStamp(),td=getTodayUntilNow();this.context=[{role:"system",content:getConfigValue("角色设定","")},{role:"user",content:`from 系统（QQ:${this.userId}）[${ts}|${td}s]: 对话已重置`},{role:"assistant",content:resetSum?"检测到问题，已重置对话和摘要~":"检测到问题，已重置对话（摘要保留）~"}];if(resetSum)this.saveSummary("");ext.storageSet(`deepseek_ctx_${this.userId}`,JSON.stringify(this.context));}
        loadContext(){try{const nk=`deepseek_ctx_${this.userId}`;let saved=ext.storageGet(nk);let isN=true;if(!saved){saved=ext.storageGet(this.userId);isN=false;if(saved)console.log(`[对话迁移] 用户 ${this.userId} 旧格式对话迁移`);}if(saved){let p;if(typeof saved==='string'){try{p=JSON.parse(saved);}catch(e){p=null;}}else p=saved;if(this._validateContext(p)){if(this._isOldDataFormat(p))this.context=this._migrateOldData(p);else this.context=p;if(!isN){ext.storageSet(nk,JSON.stringify(this.context));console.log(`[对话迁移完成] 用户 ${this.userId}`);}return;}}this.context=this._createNewConversation();ext.storageSet(nk,JSON.stringify(this.context));}catch(e){console.error(`[上下文加载错误] 用户 ${this.userId}:`,e);this.context=this._createNewConversation();ext.storageSet(nk,JSON.stringify(this.context));}}
        _enforceRules(){const maxRounds=parseInt(getConfigValue("存储上下文对话限制轮数","4"))||4;const maxM=maxRounds*2;if(this.context.length>maxM+1){const sys=this.context.find(m=>m.role==="system")||{role:"system",content:getConfigValue("角色设定","")};this.context=[sys,...this.context.slice(-maxM)];ext.storageSet(`deepseek_ctx_${this.userId}`,JSON.stringify(this.context));}}
        parseLibraryContent(n){return (getConfigValue(n,"")||"").trim();}
        getLibraryType(n){return ({full_library:"完整资料库",sub1_library:"子资料库1",sub2_library:"子资料库2",sub3_library:"子资料库3"})[n]||"通用资料";}
        getAllLibrariesContent(){let r="";for(const n of ["full_library","sub1_library","sub2_library","sub3_library"]){const c=this.parseLibraryContent(n);if(c)r+=`【${this.getLibraryType(n)}】\n${c}\n\n`;}return r.trim();}
        getLibraryStats(){return ["full_library","sub1_library","sub2_library","sub3_library"].map(n=>({name:n,configType:this.getLibraryType(n),contentLength:this.parseLibraryContent(n).length,hasContent:this.parseLibraryContent(n).length>0}));}
        buildApiRequest(messages){const te=getConfigValue("思考模式开关",true);const re=getConfigValue("思考强度","high");const b={model:getConfigValue("大模型模型名","deepseek-v4-flash"),messages,max_tokens:parseInt(getConfigValue("最大回复tokens数","600"))||600,temperature:this.getTemperature(),stream:false};if(te){b.reasoning_effort=re;b.extra_body={thinking:{type:"enabled"}};}return b;}
        async chat(text, ctx, msg) {
            const curGid = ctx && !ctx.isPrivate ? (ctx.group && ctx.group.groupId) : undefined;
            this.updateSystemContext(false, curGid);
            if (!this._validateContext(this.context)) this._resetConversation(false);
            const ts = getCurrentTimeStamp(), td = getTodayUntilNow();
            this.context.push({role:"user",content:`from ${msg.sender.nickname}（QQ:${msg.sender.userId}）[${ts}|${td}s]: ${text}`});
            this._enforceRules();
            try {
                const msgs = [...this.context];
                const resp = await fetch(getConfigValue("大模型url","https://api.deepseek.com/v1/chat/completions"),{method:"POST",headers:{Authorization:`Bearer ${getConfigValue("你的APIkeys","")}`,"Content-Type":"application/json"},body:JSON.stringify(this.buildApiRequest(msgs))});
                if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
                const data = await resp.json();
                if (data.choices?.[0]?.message) {
                    const reply = data.choices[0].message.content; const clean = parseMarkdown(reply);
                    this.context.push({role:"assistant",content:reply});
                    ext.storageSet(`deepseek_ctx_${this.userId}`, JSON.stringify(this.context));
                    this.generateSummaryAsync();
                    return seal.replyToSender(ctx, msg, clean.replace(/from .+?: /g,""));
                }
                throw new Error("Invalid API response: No choices found");
            } catch (e) { console.error(`[对话错误] 用户 ${this.userId}:`, e); this._resetConversation(false); return seal.replyToSender(ctx, msg, e.message.includes('HTTP')||e.message.includes('Network')?"网络连接失败，已保留对话记录，请稍后重试":`API请求失败: ${e.message}\n已自动重置对话上下文`); }
        }
        async generateSummaryAsync() {
            // V2.3.5：摘要功能关闭时，不再调用大模型生成/更新摘要，直接返回（旧数据保留）
            if (!isSummaryEnabled()) return;
            if (this.context.length < 4) return;
            setTimeout(async () => {
                try {
                    const prev = this.loadSummary();
                    // 仅保留 user/assistant 真实多轮，避免首条 system 与摘要 system 提示叠加成多 system
                    const dialog = (this.context || []).filter(m => m && (m.role === "user" || m.role === "assistant"));
                    if (dialog.length < 2) return;
                    let sp = [];
                    if (prev.content && prev.content.trim().length > 0) sp.push({role:"system",content:`之前的对话摘要：${prev.content}\n\n请基于这个摘要和最新的对话内容，更新对话摘要。`});
                    sp = sp.concat(dialog.slice(-6), [{role:"user",content:getConfigValue("摘要生成提示词","")}]);
                    // V2.3.8：直接读取「摘要生成最大tokens数」，与基础设置保持一致（去掉 Math.max(1000,...) 强制下限）
                    const maxTok = parseInt(getConfigValue("摘要生成最大tokens数","1000")) || 1000;
                    const r = await fetch(getConfigValue("大模型url","https://api.deepseek.com/v1/chat/completions"),{method:"POST",headers:{Authorization:`Bearer ${getConfigValue("你的APIkeys","")}`,"Content-Type":"application/json"},body:JSON.stringify({model:getConfigValue("大模型模型名","deepseek-v4-flash"),messages:sp,max_tokens:maxTok})});
                    if (!r.ok) { console.error(`[个人摘要] 用户 ${this.userId} HTTP ${r.status}: ${(await r.text()).slice(0,300)}`); return; }
                    const d = await r.json(); const choice = d.choices && d.choices[0];
                    if (!choice || !choice.message) return;
                    const newContent = (choice.message.content || "").trim();
                    if (!newContent) { console.log(`[个人摘要] 用户 ${this.userId} 本次未生成有效正文（finish_reason=${choice.finish_reason||""}），保留原有摘要`); return; }
                    if (choice.finish_reason === "length") { console.log(`[个人摘要] 用户 ${this.userId} 因 max_tokens 截断，正文可能不完整，保留原有摘要`); return; }
                    this.saveSummary(newContent); this.updateSystemContext();
                } catch (e) { console.error(`[摘要生成错误] 用户 ${this.userId}:`, e); }
            }, 500);
        }
        viewSummary(){const s=this.loadSummary();return s.content&&s.content.trim().length>0?`最后更新: ${s.lastUpdated}\n对话摘要: ${s.content}`:"暂无对话摘要";}
        async updateSummary(){if(!isSummaryEnabled())return "摘要功能当前已关闭，未执行更新。可在配置中开启「摘要功能总开关」后重试。";try{await this.generateSummaryAsync();return "对话摘要已更新";}catch(e){console.error(`[手动摘要更新错误] 用户 ${this.userId}:`,e);return "摘要更新失败";}}
    }

    // ==================== 随机插话系统 ====================
    const CHAOS_STATE_KEY = "deepseek_chaos_statemap";
    // chaosState 结构：
    //   enabled: { [groupId]: true }        —— 各群聊独立启用状态（非指令关键词控制）
    //   remain:  { [groupId]: N }           —— 各群聊剩余触发计数
    //   lastChaosGroupByUser: { [userId]: gid } —— 用户最近一次活跃插话群（私聊回退用）
    //   pendingCommand: { groupId, expireAt }   —— V2.3.6：标记「刚执行了指令、等待捕获其回复结果」的群（仅内存，不落盘）
    let chaosState = { enabled:{}, remain:{}, lastChaosGroupByUser:{}, pendingCommand:{} };
    try { const s = ext.storageGet(CHAOS_STATE_KEY); if (s) { const p = typeof s==='string'?JSON.parse(s):s; if (p && typeof p==='object') chaosState = {...chaosState, ...p, enabled: {...(chaosState.enabled||{}), ...(p.enabled||{})}, remain: {...(chaosState.remain||{}), ...(p.remain||{})}, lastChaosGroupByUser: {...(chaosState.lastChaosGroupByUser||{}), ...(p.lastChaosGroupByUser||{})}, pendingCommand: {...(chaosState.pendingCommand||{}), ...((p&&p.pendingCommand)||{})}}; } } catch (e) {}

    function saveChaosState() { try { ext.storageSet(CHAOS_STATE_KEY, JSON.stringify(chaosState)); } catch (e) {} }
    function getChaosCtxKey(groupId) { return `deepseek_chaosctx_${groupId}`; }
    function getChaosSumKey(groupId) { return `deepseek_chaossummary_${groupId}`; }

    // 判断某个群聊是否启用了随机插话：总开关开启 且 该群聊在 enabled 列表中
    function isChaosEnabledFor(gid) {
        if (!getConfigValue("随机插话总开关", false)) return false;
        return !!(chaosState.enabled[gid]);
    }

    function loadChaosContext(groupId) {
        try { const saved = ext.storageGet(getChaosCtxKey(groupId)); if (saved) { const p = typeof saved==='string'?JSON.parse(saved):saved; if (Array.isArray(p) && p.length>0) return p; } }
        catch (e) { console.error(`[插话上下文加载错误] ${groupId}:`, e); }
        return [{role:"system",content:getConfigValue("角色设定","")}];
    }
    function saveChaosContext(groupId, ctx) { try { ext.storageSet(getChaosCtxKey(groupId), JSON.stringify(ctx)); } catch (e) {} }
    function loadChaosSummary(groupId) {
        try { const saved = ext.storageGet(getChaosSumKey(groupId)); if (saved) { const p = typeof saved==='string'?JSON.parse(saved):saved; if (p&&typeof p.content==='string') return p; } }
        catch (e) {} return {content:"",lastUpdated:getCurrentTimeStamp(),version:"1.0"};
    }
    function saveChaosSummary(groupId, c) { try { ext.storageSet(getChaosSumKey(groupId), JSON.stringify({content:c||"",lastUpdated:getCurrentTimeStamp(),version:"1.0"})); } catch (e) {} }

    // 构建插话 system：角色设定 + 资料库 + 插话摘要 + 个人摘要（若有）
    function buildChaosSystemContext(groupId, personalUserId) {
        let sys = getConfigValue("角色设定","");
        const libs = ["full_library","sub1_library","sub2_library","sub3_library"];
        let libC = ""; for (const n of libs) { const c = (getConfigValue(n,"")||"").trim(); if (c) libC += `【${({full_library:"完整资料库",sub1_library:"子资料库1",sub2_library:"子资料库2",sub3_library:"子资料库3"})[n]}】\n${c}\n\n`; }
        if (libC) sys += `\n\n【资料库信息】\n${libC.trim()}\n──────────\n`;
        // V2.3.5：摘要功能关闭时，不将群聊插话摘要与发言者个人对话摘要注入系统上下文；旧摘要数据保留
        if (isSummaryEnabled()) {
            const cs = loadChaosSummary(groupId);
            if (cs.content && cs.content.trim().length > 0) sys += `\n\n【群聊插话摘要】\n${cs.content}\n──────────\n`;
            if (personalUserId) {
                try { const ps = new DeepseekAI(personalUserId).loadSummary(); if (ps.content && ps.content.trim().length > 0) sys += `\n\n【发言者个人对话摘要】\n${ps.content}\n──────────\n`; } catch (e) {}
            }
        }
        return sys;
    }

    // 确保插话上下文以最新 system 开头
    function ensureChaosSystem(groupId, personalUserId) {
        const sm = {role:"system",content:buildChaosSystemContext(groupId, personalUserId)};
        let cctx = loadChaosContext(groupId);
        if (cctx.length>0 && cctx[0] && cctx[0].role==="system") cctx[0] = sm; else cctx.unshift(sm);
        return cctx;
    }

    // 截断插话上下文到配置的群聊上下文轮数
    function truncateChaosContext(cctx) {
        const maxR = (parseInt(getConfigValue("随机插话群聊上下文轮数","8"))||8)*2 + 1;
        if (cctx.length > maxR) cctx = [cctx[0], ...cctx.slice(-(maxR-1))];
        return cctx;
    }

    // ==================== V2.3.6：插话上下文公共写入入口 ====================
    // 统一的「写入插话上下文」函数：供「普通群消息 / 指令消息 / 指令结果」三处复用。
    //   groupId: 群号
    //   senderTag: 发送者标识文本（如 "昵称（QQ:123）"）；指令结果可传入 "骰子(指令结果)" 之类
    //   text: 消息正文
    //   role: "user" | "assistant"（指令消息→user，指令结果→assistant）
    // 写入时会自动补齐最新 system、截断到上下文轮数并落盘。
    // 注意：本函数只负责「记录上下文」，不递减 remain 计数、不触发插话，调用方需自行决定是否计数。
    function appendChaosContext(groupId, senderTag, text, role) {
        if (!groupId) return;
        if (typeof text !== 'string' || !text.trim()) return;
        try {
            let cctx = ensureChaosSystem(groupId, undefined);
            const ts = getCurrentTimeStamp(), td = getTodayUntilNow();
            const content = `from ${senderTag}（${ts}|${td}s）: ${text}`;
            // 去重保护：若与上一条记录正文完全一致（同一条指令被多个钩子派发），则不重复写入
            if (cctx.length > 1 && cctx[cctx.length-1].content === content) return;
            cctx.push({role: (role === "assistant") ? "assistant" : "user", content});
            cctx = truncateChaosContext(cctx);
            saveChaosContext(groupId, cctx);
        } catch (e) { console.error(`[插话上下文写入错误] ${groupId}:`, e); }
    }

    // V2.3.6：记录「指令消息」到插话上下文（让插话AI能看到群里的指令）。
    // 仅在该群已启用随机插话时记录；指令消息不计入触发累计条数（由调用方保证不 decrement remain）。
    function recordCommandMessageForChaos(ctx, msg) {
        if (!msg || !msg.message) return;
        // 仅群聊；且当前群已启用随机插话（总开关 + 本群启用）——与随机插话作用域严格一致
        if (ctx && ctx.isPrivate) return;
        const gid = ctx && ctx.group && ctx.group.groupId;
        if (!gid) return;
        if (!isChaosEnabledFor(gid)) return;
        // 开启/关闭随机插话等非指令关键词控制消息，已在 tryHandleChaosKeyword 处理，这里也一并纳入上下文（无害）；
        // 但强制触发关键词消息本身也会走普通消息路径，此处不再重复写入，避免双份。
        if (isForceTriggerKeyword(msg.message)) return;
        const tag = (msg.sender && msg.sender.nickname) ? msg.sender.nickname : "指令";
        appendChaosContext(gid, `${tag}（指令）`, String(msg.message).trim(), "user");
    }

    // 判断消息是否仅为「强制触发关键词」消息（避免与 onNotCommandReceived 普通路径重复写入）
    function isForceTriggerKeyword(text) {
        const kw = getConfigValue("随机插话强制触发关键词","") || "";
        return !!(kw && typeof text === 'string' && text.includes(kw));
    }

    // V2.3.6：标记「某群刚执行了指令，等待捕获其回复结果」
    function markPendingCommandResult(groupId) {
        if (!groupId) return;
        // 简单过期保护：防止某次标记后始终未被消费而长期滞留（兜底，通常紧接着就会被 OnMessageSend 消费）
        chaosState.pendingCommand = { groupId: String(groupId), expireAt: Date.now() + 30000 };
        saveChaosState();
    }
    function consumePendingCommandResult(groupId) {
        const p = chaosState.pendingCommand;
        if (!p || !p.groupId) return false;
        if (p.expireAt && Date.now() > p.expireAt) { chaosState.pendingCommand = {}; saveChaosState(); return false; }
        if (String(p.groupId) === String(groupId)) { chaosState.pendingCommand = {}; saveChaosState(); return true; }
        return false;
    }

    // ==================== 关联群聊插话摘要聚合（V2.3.2） ====================
    // 群聊：直接返回当前群的插话摘要（若有）。
    // 私聊：按「私聊关联群号」列表（开关控制）+ 该用户最近一次活跃插话群，聚合多群插话摘要。
    // 返回拼接后的纯文本块；无任何可用摘要时返回 ""。
    function buildLinkedChaosSummaryBlock(userId, currentGroupId) {
        const groups = [];
        if (currentGroupId) {
            groups.push(String(currentGroupId));
        } else {
            // 私聊：关联群号列表（受开关控制）+ 最近活跃插话群
            const linked = getLinkedGroupIds();
            for (const g of linked) { if (g && !groups.includes(g)) groups.push(g); }
            const lastG = chaosState && chaosState.lastChaosGroupByUser && chaosState.lastChaosGroupByUser[userId];
            if (lastG && !groups.includes(String(lastG))) groups.push(String(lastG));
        }
        if (groups.length === 0) return "";
        const parts = [];
        for (const g of groups) {
            const s = loadChaosSummary(g);
            if (s && s.content && s.content.trim().length > 0) {
                parts.push(`（群 ${g}）${s.content.trim()}`);
            }
        }
        return parts.join("\n\n");
    }

    // 异步生成/更新插话摘要（使用随机插话设置分组下独立的"随机插话摘要提示词"，与个人对话摘要提示词互不干扰）
    // V2.3.4 修复：重构造 messages 避免多 system 冲突；落盘前校验 content 非空且 finish_reason 非 length，
    // 防止空正文覆盖有效旧摘要；补全思考模式参数与失败日志。
    function generateChaosSummaryAsync(groupId) {
        // V2.3.5：摘要功能关闭时，不再生成/更新群聊插话摘要，直接返回（旧数据保留）
        if (!isSummaryEnabled()) return;
        setTimeout(async () => {
            try {
                const nc = loadChaosContext(groupId);
                // 仅保留 user/assistant 真实对话轮次（剔除首条 system），至少需 1 轮(user+assistant)
                const dialog = (nc || []).filter(m => m && (m.role === "user" || m.role === "assistant"));
                if (dialog.length < 2) { console.log(`[插话摘要] ${groupId} 上下文对话不足一轮，跳过生成`); return; }
                const prev = loadChaosSummary(groupId);
                const chaosSp = getConfigValue("随机插话摘要提示词","") || "请基于群聊插话对话内容，生成/更新一份简洁的群聊插话摘要，保留关键信息、话题走向和重要结论。";
                // 构造 messages：有旧摘要时用一个 system 设定续写任务；随后为最近多轮对话(user/assistant) + 末尾摘要提示词(user)
                let sp = [];
                if (prev.content && prev.content.trim().length > 0) {
                    sp.push({role:"system", content:`你正在维护一份群聊插话摘要。已有摘要如下：\n${prev.content}\n\n请基于该摘要和最新插话内容，更新并输出完整的新摘要（中文，连贯、简洁）。`});
                } else {
                    sp.push({role:"system", content:"你正在为群聊插话生成一份摘要。请基于提供的对话内容，输出一份简洁、连贯的摘要（中文），保留关键信息、话题走向和重要结论。"});
                }
                sp = sp.concat(dialog.slice(-6), [{role:"user", content: chaosSp}]);
                // V2.3.8：直接读取「摘要生成最大tokens数」，与基础设置保持一致（去掉 Math.max(1000,...) 强制下限）
                const maxTok = parseInt(getConfigValue("摘要生成最大tokens数","1000")) || 1000;
                const body = { model: getConfigValue("大模型模型名","deepseek-v4-flash"), messages: sp, max_tokens: maxTok, stream: false };
                // 与 triggerChaos/正常对话对齐：注入思考模式参数（V4 默认 high，显式传入保持一致）
                if (getConfigValue("思考模式开关",false)) {
                    body.reasoning_effort = getConfigValue("思考强度","high");
                    body.extra_body = {"thinking": {"type": "enabled"}};
                }
                const r = await fetch(getConfigValue("大模型url","https://api.deepseek.com/v1/chat/completions"),{method:"POST",headers:{Authorization:`Bearer ${getConfigValue("你的APIkeys","")}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
                if (!r.ok) { console.error(`[插话摘要] ${groupId} HTTP ${r.status}: ${(await r.text()).slice(0,300)}`); return; }
                const d = await r.json();
                const choice = d.choices && d.choices[0];
                if (!choice || !choice.message) { console.error(`[插话摘要] ${groupId} 响应无 choices/message`); return; }
                const newContent = (choice.message.content || "").trim();
                const finish = choice.finish_reason;
                // 仅当正文非空 且 非因达到 max_tokens 被截断时，才覆盖旧摘要；否则保留旧摘要
                if (!newContent) { console.log(`[插话摘要] ${groupId} 本次未生成有效正文（finish_reason=${finish||""}），保留原有摘要`); return; }
                if (finish === "length") { console.log(`[插话摘要] ${groupId} 因达到 max_tokens 截断（finish_reason=length），正文可能不完整，保留原有摘要`); return; }
                saveChaosSummary(groupId, newContent);
                console.log(`[插话摘要] ${groupId} 摘要已更新（${newContent.length} 字符）`);
            } catch(e) { console.error(`[插话摘要生成错误] ${groupId}:`,e); }
        }, 500);
    }

    // 随机插话触发：累计到阈值 或 含强制触发关键词
    // V2.3.8 修复：将「计数递减 + 判断 + 重置」原子化到本函数内部，避免调用方递减后 await 期间
    // 被后续消息重复读取导致的重复触发/漏触发；达到触发条件时立即重置计数，API 失败也不会
    // 让 remain 长期停留在 <=0 而每条消息都触发。
    async function triggerChaos(ctx, msg, groupId) {
        const N = parseInt(getConfigValue("随机插话每N条触发","5")) || 5;
        const forceKw = getConfigValue("随机插话强制触发关键词","") || "";
        const isForce = forceKw && msg.message.includes(forceKw);

        // —— 计数递减与触发判断（原子） ——
        let cur = (chaosState.remain[groupId] === undefined) ? N : chaosState.remain[groupId];
        const next = cur - 1;
        chaosState.remain[groupId] = next;
        const should = isForce || (next <= 0);
        if (!should) { saveChaosState(); return false; }

        // 达到触发条件：先立即重置计数，防止 await 期间被后续消息重复触发
        chaosState.remain[groupId] = N;
        saveChaosState();

        // 构造插话上下文（含最新 system + 累积的历史 user/assistant）
        let cctx = ensureChaosSystem(groupId, msg.sender.userId);
        const ts = getCurrentTimeStamp(), td = getTodayUntilNow();
        cctx.push({role:"user",content:`from ${msg.sender.nickname}（QQ:${msg.sender.userId}）[${ts}|${td}s]: ${msg.message}`});
        cctx = truncateChaosContext(cctx);

        // 构造请求
        const tempVal = (() => { try { return new DeepseekAI(msg.sender.userId).getTemperature(); } catch(e) { return 1.3; } })();
        const body = {
            model: getConfigValue("大模型模型名","deepseek-v4-flash"),
            messages: cctx,
            max_tokens: parseInt(getConfigValue("最大回复tokens数","600"))||600,
            temperature: tempVal,
            stream: false
        };
        if (getConfigValue("思考模式开关",false)) {
            body.reasoning_effort = getConfigValue("思考强度","high");
            body.extra_body = {thinking:{type:"enabled"}};
        }

        try {
            const resp = await fetch(getConfigValue("大模型url","https://api.deepseek.com/v1/chat/completions"),{method:"POST",headers:{Authorization:`Bearer ${getConfigValue("你的APIkeys","")}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
            if (!resp.ok) { console.error(`[随机插话] HTTP ${resp.status}: ${await resp.text()}`); return false; }
            const data = await resp.json();
            if (!data.choices?.[0]?.message) { console.error(`[随机插话] 响应无 choices`); return false; }
            const reply = data.choices[0].message.content;

            // 更新插话上下文（写入 user + assistant 轮次）
            let nc = ensureChaosSystem(groupId, msg.sender.userId);
            nc.push({role:"user",content:`from ${msg.sender.nickname}（QQ:${msg.sender.userId}）[${ts}|${td}s]: ${msg.message}`});
            nc.push({role:"assistant",content:reply});
            nc = truncateChaosContext(nc);
            saveChaosContext(groupId, nc);

            // 异步更新插话摘要
            generateChaosSummaryAsync(groupId);

            // V2.3.2：插话成功时记录该用户最近活跃插话群（供私聊关联群回退）
            try { chaosState.lastChaosGroupByUser[msg.sender.userId] = String(groupId); } catch(e) {}
            saveChaosState();

            seal.replyToSender(ctx, msg, parseMarkdown(reply).replace(/from .+?: /g,""));
            return true;
        } catch (e) { console.error(`[随机插话错误] ${groupId}:`, e); }
        return false;
    }

    // ==================== 指令定义（使用 seal.ext.registerCmd 注册，确保 1.6.0 指令可被识别） ====================
    function registerCmd(cmdItem) {
        try {
            if (typeof seal.ext.registerCmd === 'function') {
                seal.ext.registerCmd(ext, cmdItem);
            } else {
                // 兜底：写入 cmdMap
                ext.cmdMap = ext.cmdMap || {};
                ext.cmdMap[cmdItem.name] = cmdItem;
            }
        } catch (e) { console.error(`[指令注册失败] ${cmdItem.name}:`, e); }
    }

    const cmdReset = seal.ext.newCmdItemInfo(); cmdReset.name="重置AI"; cmdReset.help="重置AI对话上下文（保留摘要）"; cmdReset.solve=(ctx,msg)=>{new DeepseekAI(msg.sender.userId)._resetConversation(false);seal.replyToSender(ctx,msg,"已重置对话上下文（摘要已保留）");}; registerCmd(cmdReset);
    const cmdResetSummary = seal.ext.newCmdItemInfo(); cmdResetSummary.name="重置摘要"; cmdResetSummary.help="重置对话摘要（保留对话上下文）"; cmdResetSummary.solve=(ctx,msg)=>seal.replyToSender(ctx,msg,new DeepseekAI(msg.sender.userId).resetSummary()); registerCmd(cmdResetSummary);
    const cmdResetAll = seal.ext.newCmdItemInfo(); cmdResetAll.name="重置全部"; cmdResetAll.help="同时重置对话上下文和摘要"; cmdResetAll.solve=(ctx,msg)=>{new DeepseekAI(msg.sender.userId)._resetConversation(true);seal.replyToSender(ctx,msg,"已重置对话上下文和摘要");}; registerCmd(cmdResetAll);
    const cmdCheck = seal.ext.newCmdItemInfo(); cmdCheck.name="检查对话"; cmdCheck.help="检查当前对话状态"; cmdCheck.solve=(ctx,msg)=>{const ai=new DeepseekAI(msg.sender.userId);const v=ai._validateContext(ai.context);const s=ai.loadSummary();seal.replyToSender(ctx,msg,v?`当前对话状态正常\n摘要状态: ${s.content?"已生成":"未生成"}`:"对话数据异常，建议使用【重置AI】");}; registerCmd(cmdCheck);
    const cmdUpdateRole = seal.ext.newCmdItemInfo(); cmdUpdateRole.name="更新角色"; cmdUpdateRole.help="更新系统角色为最新配置"; cmdUpdateRole.solve=(ctx,msg)=>{new DeepseekAI(msg.sender.userId).updateSystemContext();seal.replyToSender(ctx,msg,"系统角色已更新为最新配置");}; registerCmd(cmdUpdateRole);
    const cmdContextStatus = seal.ext.newCmdItemInfo(); cmdContextStatus.name="上下文状态"; cmdContextStatus.help="查看当前保存的对话轮数"; cmdContextStatus.solve=(ctx,msg)=>{const ai=new DeepseekAI(msg.sender.userId);const r=Math.max(0,(ai.context.length-1)/2);seal.replyToSender(ctx,msg,`当前保存: ${r}轮对话（最大${getConfigValue("存储上下文对话限制轮数","16")}轮）`);}; registerCmd(cmdContextStatus);
    const cmdViewSummary = seal.ext.newCmdItemInfo(); cmdViewSummary.name="查看摘要"; cmdViewSummary.help="查看当前的对话摘要"; cmdViewSummary.solve=(ctx,msg)=>seal.replyToSender(ctx,msg,`对话摘要信息:\n${new DeepseekAI(msg.sender.userId).viewSummary()}`); registerCmd(cmdViewSummary);
    const cmdUpdateSummary = seal.ext.newCmdItemInfo(); cmdUpdateSummary.name="更新摘要"; cmdUpdateSummary.help="手动更新对话摘要"; cmdUpdateSummary.solve=async(ctx,msg)=>seal.replyToSender(ctx,msg,await new DeepseekAI(msg.sender.userId).updateSummary()); registerCmd(cmdUpdateSummary);
    const cmdViewTemperature = seal.ext.newCmdItemInfo(); cmdViewTemperature.name="查看Temperature"; cmdViewTemperature.help="查看当前的Temperature设置"; cmdViewTemperature.solve=(ctx,msg)=>{const t=new DeepseekAI(msg.sender.userId).getTemperature();seal.replyToSender(ctx,msg,`当前Temperature: ${t}\n推荐设置:\n0.0 - 代码生成/数学解题\n1.0 - 数据抽取/分析\n1.3 - 通用对话/翻译\n1.5 - 创意类写作/诗歌创作`);}; registerCmd(cmdViewTemperature);
    const cmdSetTemperature = seal.ext.newCmdItemInfo(); cmdSetTemperature.name="设置Temperature"; cmdSetTemperature.help="设置Temperature值 (0.0-2.0)"; cmdSetTemperature.solve=(ctx,msg,cmdArgs)=>{const v=cmdArgs.getArgN(1);if(!v){seal.replyToSender(ctx,msg,"请提供Temperature值，例如: .设置Temperature 1.3");return;}const t=parseFloat(v);if(isNaN(t)||t<0||t>2){seal.replyToSender(ctx,msg,"Temperature值必须在0.0到2.0之间");return;}seal.ext.registerStringConfig(ext,"Temperature",t.toString(),"Temperature设置 (0.0-2.0)","基础设置");seal.replyToSender(ctx,msg,`Temperature已设置为: ${t}\n推荐设置:\n0.0 - 代码/数学\n1.0 - 数据抽取\n1.3 - 通用对话\n1.5 - 创意写作`);}; registerCmd(cmdSetTemperature);
    const cmdViewThinking = seal.ext.newCmdItemInfo(); cmdViewThinking.name="查看思考模式"; cmdViewThinking.help="查看当前的思考模式状态"; cmdViewThinking.solve=(ctx,msg)=>seal.replyToSender(ctx,msg,`思考模式: ${getConfigValue("思考模式开关",false)?"开启":"关闭"}\n思考强度: ${getConfigValue("思考强度","high")}`); registerCmd(cmdViewThinking);
    const cmdSetThinking = seal.ext.newCmdItemInfo(); cmdSetThinking.name="设置思考模式"; cmdSetThinking.help="设置思考模式 (on/off)"; cmdSetThinking.solve=(ctx,msg,cmdArgs)=>{const v=cmdArgs.getArgN(1);if(v==="on"){seal.ext.registerBoolConfig(ext,"思考模式开关",true,"思考模式开关（开/关）","基础设置");seal.replyToSender(ctx,msg,"思考模式已开启");}else if(v==="off"){seal.ext.registerBoolConfig(ext,"思考模式开关",false,"思考模式开关（开/关）","基础设置");seal.replyToSender(ctx,msg,"思考模式已关闭");}else seal.replyToSender(ctx,msg,"请使用: .设置思考模式 on 或 .设置思考模式 off");}; registerCmd(cmdSetThinking);
    const cmdSetEffort = seal.ext.newCmdItemInfo(); cmdSetEffort.name="设置思考强度"; cmdSetEffort.help="设置思考强度 (high/max)"; cmdSetEffort.solve=(ctx,msg,cmdArgs)=>{const v=cmdArgs.getArgN(1);if(v==="high"||v==="max"){seal.ext.registerOptionConfig(ext,"思考强度",v,["high","max"],"思考强度设置 (high/max)","基础设置");seal.replyToSender(ctx,msg,`思考强度已设置为: ${v}`);}else seal.replyToSender(ctx,msg,"请使用: .设置思考强度 high 或 .设置思考强度 max");}; registerCmd(cmdSetEffort);
    const cmdLibraryStatus = seal.ext.newCmdItemInfo(); cmdLibraryStatus.name="资料库状态"; cmdLibraryStatus.help="查看所有长文本资料库的状态"; cmdLibraryStatus.solve=(ctx,msg)=>{const stats=new DeepseekAI(msg.sender.userId).getLibraryStats();let s="资料库状态:\n\n";stats.forEach(st=>{s+=`【${st.configType}】\n配置项: ${st.name}\n内容长度: ${st.contentLength}字符\n状态: ${st.hasContent?"已配置":"未配置"}\n\n`;});seal.replyToSender(ctx,msg,s.trim());}; registerCmd(cmdLibraryStatus);
    const cmdUpdateLibrary = seal.ext.newCmdItemInfo(); cmdUpdateLibrary.name="更新资料库"; cmdUpdateLibrary.help="手动更新当前用户的资料库内容"; cmdUpdateLibrary.solve=(ctx,msg)=>{new DeepseekAI(msg.sender.userId).updateSystemContext(true);seal.replyToSender(ctx,msg,"当前用户的资料库已更新");}; registerCmd(cmdUpdateLibrary);

    // —— 随机插话管理指令（仅保留状态查询/查看摘要为指令；开启/关闭改为非指令关键词）——
    // 状态查询：显示总开关 + 当前群聊的启用状态
    const cmdChaosStatus = seal.ext.newCmdItemInfo(); cmdChaosStatus.name="随机插话状态"; cmdChaosStatus.help="查看随机插话功能状态（受「随机插话控制需要高级权限」开关约束）"; cmdChaosStatus.solve=(ctx,msg)=>{
        // V2.3.7：权限与非指令关键词控制开启/关闭保持一致，受「随机插话控制需要高级权限」开关控制（默认开，即仅高权限可用）
        if (!!getConfigValue("随机插话控制需要高级权限", true) && ctx.privilegeLevel < 100) { seal.replyToSender(ctx,msg,seal.formatTmpl(ctx,"核心:提示_无权限")); return; }
        const gid = ctx.isPrivate ? ctx.player.userId : ctx.group.groupId;
        const masterOn = getConfigValue("随机插话总开关",false);
        const N = parseInt(getConfigValue("随机插话每N条触发","5"))||5;
        const rem = (chaosState.remain[gid] === undefined) ? N : chaosState.remain[gid];
        const scope = ctx.isPrivate ? `私聊(${gid})` : `群聊(${gid})`;
        const sessionOn = !!chaosState.enabled[gid];
        const onKw = getConfigValue("随机插话开启关键词","开启随机插话");
        const offKw = getConfigValue("随机插话关闭关键词","关闭随机插话");
        let reply = `【随机插话状态】\n`;
        reply += `模块总开关: ${masterOn?"已开启":"未开启"}\n`;
        reply += `当前会话(${scope}): ${sessionOn?"已启用":"未启用"}\n`;
        reply += `每 ${N} 条消息触发一次\n当前剩余消息条数: ${rem}\n`;
        if (!masterOn) reply += `\n提示：模块总开关未开启，请先在配置中开启「随机插话总开关」。`;
        else if (!sessionOn) reply += `\n提示：当前会话未启用，请在群聊中发送包含「${onKw}」的普通消息（无需「.」前缀）启用本群随机插话。`;
        const needPriv = !!getConfigValue("随机插话控制需要高级权限", true);
        reply += `\n\n—— 非指令关键词控制（群聊内） ——\n开启关键词: ${onKw}\n关闭关键词: ${offKw}\n权限要求: ${needPriv ? "仅高权限" : "任何人可用（无需高权限）"}`;
        reply += `\n（群聊上下文/摘要与个人对话数据独立存储）`;
        seal.replyToSender(ctx,msg,reply);
    }; registerCmd(cmdChaosStatus);

    // 查看插话摘要（保留为指令）
    const cmdViewChaosSummary = seal.ext.newCmdItemInfo(); cmdViewChaosSummary.name="查看插话摘要"; cmdViewChaosSummary.help="查看当前群聊的随机插话摘要（受「随机插话控制需要高级权限」开关约束）"; cmdViewChaosSummary.solve=(ctx,msg)=>{
        // V2.3.7：权限与非指令关键词控制开启/关闭保持一致，受「随机插话控制需要高级权限」开关控制（默认开，即仅高权限可用）
        if (!!getConfigValue("随机插话控制需要高级权限", true) && ctx.privilegeLevel < 100) { seal.replyToSender(ctx,msg,seal.formatTmpl(ctx,"核心:提示_无权限")); return; }
        const gid = ctx.isPrivate ? ctx.player.userId : ctx.group.groupId;
        const s = loadChaosSummary(gid);
        if (s.content && s.content.trim().length>0) seal.replyToSender(ctx,msg,`群聊(${gid}) 插话摘要:\n最后更新: ${s.lastUpdated}\n${s.content}`);
        else seal.replyToSender(ctx,msg,`群聊(${gid}) 暂无插话摘要`);
    }; registerCmd(cmdViewChaosSummary);

    // ==================== 非指令关键词控制随机插话开启/关闭（V2.3.3 核心改动，V2.3.7 权限可配置） ====================
    // 在群聊中，当普通消息（非指令）包含配置的开启/关闭关键词时，控制本群随机插话的启用状态。
    // 权限受「随机插话控制需要高级权限」开关控制（默认开）：
    //   - 开关开启（默认）：仅高权限（privilegeLevel ≥ 100）可控制，保持原有行为；
    //   - 开关关闭：任何人均可通过非指令关键词开启/关闭本群随机插话，无需骰主/高权限。
    // 私聊中不处理（随机插话按群聊隔离，私聊无关联群概念）。
    // 返回 true 表示已处理（关键词命中），调用方应跳过后续随机插话计数/触发逻辑。
    function tryHandleChaosKeyword(ctx, msg) {
        // 仅在群聊中生效
        if (ctx.isPrivate) return false;
        const gid = ctx.group.groupId;

        const onKw = getConfigValue("随机插话开启关键词","开启随机插话") || "";
        const offKw = getConfigValue("随机插话关闭关键词","关闭随机插话") || "";
        const text = msg.message || "";

        const hitOn = onKw && text.includes(onKw);
        const hitOff = offKw && text.includes(offKw);

        if (!hitOn && !hitOff) return false;

        // 权限校验：受「随机插话控制需要高级权限」开关控制（默认开，即仅高权限可控制）
        // 开关关闭时跳过权限校验，任何人都能通过关键词控制开启/关闭
        if (!!getConfigValue("随机插话控制需要高级权限", true) && ctx.privilegeLevel < 100) {
            seal.replyToSender(ctx, msg, seal.formatTmpl(ctx, "核心:提示_无权限"));
            return true; // 已处理（拒绝），不再走后续插话逻辑
        }

        if (hitOn) {
            // 开启本群随机插话
            if (!getConfigValue("随机插话总开关", false)) {
                seal.replyToSender(ctx, msg, `随机插话模块总开关尚未开启，请先在插件配置的「随机插话设置」分组中开启「随机插话总开关」，再使用开启关键词启用本群的随机插话。`);
                return true;
            }
            chaosState.enabled[gid] = true;
            if (typeof chaosState.remain[gid] !== 'number') {
                chaosState.remain[gid] = parseInt(getConfigValue("随机插话每N条触发","5")) || 5;
            }
            saveChaosState();
            seal.replyToSender(ctx, msg, `${getConfigValue("随机插话开启回复","当前会话随机插话已开启")}（群聊 ${gid}）`);
            return true;
        }

        if (hitOff) {
            // 关闭本群随机插话
            chaosState.enabled[gid] = false;
            saveChaosState();
            seal.replyToSender(ctx, msg, `${getConfigValue("随机插话关闭回复","当前会话随机插话已关闭")}（群聊 ${gid}）`);
            return true;
        }

        return false;
    }

    // ==================== 触发与权限逻辑 ====================
    function checkAllowed(ctx) {
        const whiteOn = getConfigValue("白名单开关",false);
        if (!whiteOn) return true;
        const ag = getConfigValue("允许使用群号",[]); const ap = getConfigValue("允许使用私聊",[]);
        if (!ctx.isPrivate) return !ag||ag.length===0||ag.some(g=>String(g).includes(ctx.group.groupId.toString()));
        else return !ap||ap.length===0||ap.some(u=>String(u).includes(ctx.player.userId.toString()));
    }
    function isCommandMessage(msg){if(!msg||!msg.message)return false;const m=String(msg.message).trim();return m.charAt(0)==="."||m.charAt(0)==="。";}

    ext.onNotCommandReceived = async (ctx, msg) => {
        // V2.3.6：指令消息分支 —— 让随机插话能「看到」指令消息，但不计入触发累计条数
        if (isCommandMessage(msg)) {
            // 仅在群聊且本群已启用随机插话时，把指令消息记入插话上下文（私聊/未启用则忽略，保持原行为）
            if (!ctx.isPrivate && isChaosEnabledFor(ctx.group && ctx.group.groupId)) {
                recordCommandMessageForChaos(ctx, msg);
                // 标记「等待捕获该指令的回复结果」，供 OnMessageSend 识别
                markPendingCommandResult(ctx.group.groupId);
            }
            // 指令消息不进入普通消息的计数/触发逻辑（不计入触发累计次数），与原行为一致
            return;
        }
        const gid = ctx.isPrivate ? ctx.player.userId : ctx.group.groupId;

        // —— V2.3.3：先尝试非指令关键词控制随机插话开启/关闭（仅群聊）——
        if (tryHandleChaosKeyword(ctx, msg)) {
            // 关键词已命中并处理（开启/关闭/无权限），跳过后续逻辑
            return;
        }

        // —— 随机插话处理（总开关开启 且 当前群聊已启用）——
        if (isChaosEnabledFor(gid)) {
            // V2.3.2：记录该用户最近一次活跃插话群（仅群聊消息），供私聊回退关联群使用
            if (!ctx.isPrivate) { chaosState.lastChaosGroupByUser[msg.sender.userId] = String(gid); saveChaosState(); }
            const N = parseInt(getConfigValue("随机插话每N条触发","5"))||5;
            // 初始化当前群聊计数
            if (typeof chaosState.remain[gid] !== 'number') { chaosState.remain[gid] = N; saveChaosState(); }
            // 每条【非指令】普通消息都累积进插话上下文（供触发时作为完整上下文）
            // （V2.3.6：指令消息与指令结果走专属入口，不由此处计数，故触发节奏仅由普通消息决定）
            let cctx = ensureChaosSystem(gid, msg.sender.userId);
            const ts = getCurrentTimeStamp(), td = getTodayUntilNow();
            cctx.push({role:"user",content:`from ${msg.sender.nickname}（QQ:${msg.sender.userId}）[${ts}|${td}s]: ${msg.message}`});
            cctx = truncateChaosContext(cctx);
            saveChaosContext(gid, cctx);

            // V2.3.8 修复：计数递减与触发判断统一由 triggerChaos 内部完成，避免竞态导致重复触发/漏触发
            await triggerChaos(ctx, msg, gid);
        }

        // —— 个人对话触发（关键词命中时，走个人上下文+个人摘要）——
        const keywords = getTriggerKeywords();
        if (keywords.length > 0 && keywords.some(kw => msg.message.includes(kw))) {
            if (!checkAllowed(ctx)) return;
            new DeepseekAI(msg.sender.userId).chat(msg.message, ctx, msg);
        }
    };

    // ==================== V2.3.6：指令消息 / 指令结果 捕获（框架钩子） ====================
    // 说明：群聊中以「.」开头的指令消息会被框架的指令系统消费，通常不会进入 onNotCommandReceived，
    // 因此必须借助 OnCommandReceived（指令匹配时触发）捕获「指令消息」本身。
    // 而「指令执行结果」（骰子回复文本）则通过 OnMessageSend（框架向外发送消息时触发）捕获。
    // 两者均写入对应群的插话上下文，让随机插话AI拥有完整上下文；且均【不计入触发累计条数】。

    // —— 捕获「指令消息」：在指令执行前写入插话上下文，并标记等待其回复结果 ——
    ext.onCommandReceived = (ctx, msg, cmdArgs) => {
        try {
            if (!ctx) return;
            // 仅处理群聊中的指令，且本群已启用随机插话（作用域与随机插话严格一致）
            if (ctx.isPrivate) return;
            const gid = ctx.group && ctx.group.groupId;
            if (!gid || !isChaosEnabledFor(gid)) return;
            if (!msg || !msg.message) return;
            // 写入指令消息（role=user），不计入触发计数
            recordCommandMessageForChaos(ctx, msg);
            // 标记等待捕获该指令的回复结果
            markPendingCommandResult(gid);
        } catch (e) { console.error("[指令消息捕获错误]", e); }
    };

    // —— 捕获「指令结果（骰子/框架外发消息）」：写入插话上下文（role=assistant），不计入触发计数 ——
    ext.onMessageSend = (ctx, msg, flag) => {
        try {
            if (!ctx) return;
            if (ctx.isPrivate) return;
            const gid = ctx.group && ctx.group.groupId;
            if (!gid) return;
            // 仅处理「刚刚执行过指令、正在等待其结果」的群，避免把 AI 插话自身回复/无关消息重复写入
            if (!consumePendingCommandResult(gid)) return;
            if (!msg || !msg.message) return;
            // 仅记录文本类消息
            const text = String(msg.message).trim();
            if (!text) return;
            // 取发送者标识：优先 msg.sender，兜底用 flag / 固定文案
            let tag = "骰子";
            if (msg.sender) {
                if (msg.sender.nickname) tag = msg.sender.nickname;
                else if (msg.sender.userId) tag = String(msg.sender.userId);
            }
            // 标记为指令结果，写入插话上下文（assistant 角色），不计数
            appendChaosContext(gid, `${tag}（指令结果）`, text, "assistant");
        } catch (e) { console.error("[指令结果捕获错误]", e); }
    };

    // ==================== 帮助指令 ====================
    const cmdHelp = seal.ext.newCmdItemInfo(); cmdHelp.name="deepseekai"; cmdHelp.help="Deepseek AI插件帮助"; cmdHelp.solve=(ctx,msg)=>{
        const te=getConfigValue("思考模式开关",false);const t=new DeepseekAI(msg.sender.userId).getTemperature();
        const gid = ctx.isPrivate ? ctx.player.userId : ctx.group.groupId;
        const masterOn = getConfigValue("随机插话总开关",false);
        const sessionOn = isChaosEnabledFor(gid);
        const linkOn = getConfigValue("私聊关联群号开关",true);
        const linked = getLinkedGroupIds();
        const onKw = getConfigValue("随机插话开启关键词","开启随机插话");
        const offKw = getConfigValue("随机插话关闭关键词","关闭随机插话");
        let h="Deepseek AI插件 V4适配版 2.3.8 指令：\n\n";
        h+="思考模式控制:\n1. 查看思考模式 / 设置思考模式 on|off\n2. 设置思考强度 high|max\n3. 1. 查看Temperature / 设置Temperature 0.0-2.0\n\n";
        h+="重置指令:\n4. 重置AI 5. 重置摘要 6. 重置全部\n\n";
        h+="基础指令:\n7. 检查对话 8. 更新角色 9. 上下文状态\n10. 查看摘要 11. 更新摘要 12. 资料库状态 13. 更新资料库\n\n";
        const needPriv = !!getConfigValue("随机插话控制需要高级权限", true);
        h+="随机插话控制:\n—— 非指令关键词——\n· 发送含「"+onKw+"」的消息 → 开启本群随机插话\n· 发送含「"+offKw+"」的消息 → 关闭本群随机插话\n—— 指令（"+ (needPriv ? "仅高权限" : "任何人可用") +"，受「随机插话控制需要高级权限」开关控制） ——\n14. 随机插话状态 / 查看插话摘要\n15. 查看关联群插话摘要（私聊可用，验证私聊读取群聊插话摘要）\n\n";
        h+=`当前状态:\n思考模式: ${te?"开启":"关闭"} | 思考强度: ${getConfigValue("思考强度","high")}\n`;
        const kw=getTriggerKeywords();h+=`Temperature: ${t} | 触发关键词: ${kw.length>0?kw.join(" / "):"（未配置）"}\n`;
        h+=`随机插话 总开关: ${masterOn?"开启":"关闭"} | 当前会话: ${sessionOn?"已启用":"未启用"} | 每 ${getConfigValue("随机插话每N条触发","5")} 条触发一次\n`;
        h+=`私聊关联群号开关: ${linkOn?"开启":"关闭"} | 关联群号: ${linked.length>0?linked.join(" / "):"（未配置）"}\n`;
        h+="配置分组: 基础设置 / 个性配置 / 权限设置 / 随机插话设置\n版本: 2.3.8（修复随机插话计数竞态；随机插话回复与摘要生成的 max_tokens 现与「基础设置」保持一致；兼容旧数据）";
        seal.replyToSender(ctx,msg,h);
    };
    registerCmd(cmdHelp);

    // V2.3.2：查看关联群插话摘要（私聊可用，普通用户即可，用于验证私聊是否正确读取到关联群插话摘要）
    const cmdViewLinkedChaosSummary = seal.ext.newCmdItemInfo(); cmdViewLinkedChaosSummary.name="查看关联群插话摘要"; cmdViewLinkedChaosSummary.help="查看私聊关联群号（及最近活跃群）对应的群聊插话摘要"; cmdViewLinkedChaosSummary.solve=(ctx,msg)=>{
        const curGid = ctx && !ctx.isPrivate ? (ctx.group && ctx.group.groupId) : undefined;
        const block = buildLinkedChaosSummaryBlock(msg.sender.userId, curGid);
        const linked = getLinkedGroupIds();
        const lastG = chaosState && chaosState.lastChaosGroupByUser && chaosState.lastChaosGroupByUser[msg.sender.userId];
        let r = `【关联群聊插话摘要】\n关联群号开关: ${getConfigValue("私聊关联群号开关",true)?"开启":"关闭"}\n配置关联群: ${linked.length>0?linked.join(" / "):"（未配置）"}\n`;
        if (lastG) r += `最近活跃插话群: ${lastG}\n`;
        r += `\n`;
        if (block) r += block; else r += "（当前无可用关联群聊插话摘要；请先在对应群开启随机插话并产生插话，或在「私聊关联群号」中配置群号）";
        seal.replyToSender(ctx,msg,r);
    };
    registerCmd(cmdViewLinkedChaosSummary);

    console.log("[Deepseek AI插件加载完成] 版本 2.3.8（修复随机插话计数竞态导致的偶发不触发/重复触发；随机插话回复与摘要生成的 max_tokens 现与「基础设置」保持一致；基于 OnCommandReceived / OnMessageSend 钩子，兼容旧数据）");
}