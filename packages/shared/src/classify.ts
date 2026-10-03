/**
 * 目的地分类(§11 功能池·目的地画像的静态规则表部分,Phase 5 先行):
 * 已知域名 → 分类徽标("谁在往 AI 服务传文件")。查询时计算,规则表演进无需改库。
 * 这是启发式:后缀匹配 + 按优先级取第一个命中(ai → cloud-storage → object-storage),
 * 广义云域(aliyuncs/myqcloud 等)会偏向对象存储,个别子域可能归错类,接受。
 */

export const DESTINATION_CATEGORIES = ["ai", "cloud-storage", "object-storage"] as const;
export type DestinationCategory = (typeof DESTINATION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DestinationCategory, string> = {
  ai: "AI 服务",
  "cloud-storage": "网盘",
  "object-storage": "对象存储",
};

/** 后缀表:domain === entry 或 domain 以 ".entry" 结尾即命中 */
const RULES: ReadonlyArray<{ category: DestinationCategory; suffixes: readonly string[] }> = [
  {
    category: "ai",
    suffixes: [
      "openai.com", "chatgpt.com",
      "anthropic.com", "claude.ai",
      "gemini.google.com", "generativelanguage.googleapis.com", "aistudio.google.com",
      "deepseek.com", "moonshot.cn", "kimi.com",
      "bigmodel.cn", "chatglm.cn", "dashscope.aliyuncs.com",
      "doubao.com", "x.ai", "grok.com", "perplexity.ai", "mistral.ai",
      "huggingface.co", "githubcopilot.com",
    ],
  },
  {
    category: "cloud-storage",
    suffixes: [
      "drive.google.com", "dropbox.com", "dropboxusercontent.com",
      "onedrive.live.com", "1drv.ms", "sharepoint.com", "icloud.com",
      "mega.nz", "box.com", "pcloud.com",
      "pan.baidu.com", "aliyundrive.com", "alipan.com", "jianguoyun.com",
    ],
  },
  {
    category: "object-storage",
    suffixes: [
      "s3.amazonaws.com", "cloudflarestorage.com", "storage.googleapis.com",
      "aliyuncs.com", "myqcloud.com", "blob.core.windows.net",
      "backblazeb2.com", "wasabisys.com",
    ],
  },
];

/** 域名分类;无域名或未命中返回 undefined(不猜) */
export function classifyDomain(domain?: string | null): DestinationCategory | undefined {
  if (domain === undefined || domain === null || domain === "") return undefined;
  const d = domain.toLowerCase().replace(/\.$/, ""); // 容忍结尾点(根域写法)
  for (const rule of RULES) {
    for (const suffix of rule.suffixes) {
      if (d === suffix || d.endsWith(`.${suffix}`)) return rule.category;
    }
  }
  return undefined;
}
