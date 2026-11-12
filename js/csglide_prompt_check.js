/* ============================================================
 * 提示词检查 —— 三节点共用的一份规则
 * ------------------------------------------------------------
 * 这块原先长在导演台里，但词归文案台写：检查结果跟词不在一个节点上，用户在
 * 导演台看到"台词超时 / 缺字段"却改不了词，只能记住警告再跑到另一个节点去改。
 * 检查跟着词走，规则也只有一份 —— 两边各写一份迟早会算出不同的结论。
 *
 * 导出：
 *   fieldText(prompt, name)  取一个命名字段的正文（到下一个字段头为止）
 *   promptCheck(prompt, secs) 检查项数组 [{ label, text, state }]
 * ============================================================ */

/* 平均语速。只用来估"写出来的台词念不念得完"，不参与生成。 */
const WORDS_PER_SEC = 2.5;

const FIELD_BODY  = /^[ \t]*(?:detailed_description|integrated_multimodal_description)[ \t]*:/im;
const FIELD_SOUND = /^[ \t]*overall_soundscape[ \t]*:/im;
const FIELD_MUSIC = /^[ \t]*non_diegetic_music[ \t]*:/im;

/* <d>…</d> 是官方格式里的"台词"标记，比引号更可靠。 */
const DTAG_RE = /<d>\s*(?:\[[^\]]*\]\s*)?([^<]{1,400})<\/d>/gi;
const QUOTE_RE = /["“”]([^"”]{1,400})["”]/g;
/* a quote introduced like this is on-screen text, not speech */
const SCREEN_TEXT = /(read(?:s|ing)?|sign|banner|label|subtitle|caption|placard|logo|title card|neon|lettering|letters|text|marked|stencilled|stenciled|written)\W*$/i;
/* the official form is (S1); (S1,S2) covers simultaneous speech */
const SPEAKER_RE = /\(\s*S\d+\s*(?:,\s*S\d+\s*)*\)/;
const LIPS_RE = /lips?\s+(?:close|remain|stay|are\s+close)|close[sd]?\s+(?:his|her|their|the)\s+(?:lips|mouth)|mouths?\s+(?:closed|stay|remain)|(?:does|do)\s+not\s+speak\s+again|never\s+speaks?|says?\s+nothing\s+(?:more|further)|no\s+further\s+dialogue/i;
const SILENT_INTENT = /silen|wordless|mute|no speech|no dialogue|no words|no line|not speak|doesn't speak|says? nothing|saying nothing|without speaking|(?:neither|nobody|no one|no-one) speaks?|stays? quiet|remains? quiet|in silence|beat of quiet/i;

/* text of a named field, up to the next field header or the end of the prompt */
const ANY_FIELD = /^[ \t]*[a-z_]{4,}[ \t]*:/gm;

export function fieldText(prompt, name) {
  const head = new RegExp("^[ \\t]*" + name + "[ \\t]*:", "im").exec(prompt);
  if (!head) return null;
  const from = head.index + head[0].length;
  let stop = prompt.length, m;
  ANY_FIELD.lastIndex = from;
  while ((m = ANY_FIELD.exec(prompt)) !== null) { stop = m.index; break; }
  return prompt.slice(from, stop).trim();
}

function spokenLines(text) {
  const out = [];
  let m;
  DTAG_RE.lastIndex = 0;
  while ((m = DTAG_RE.exec(text)) !== null) out.push(m[1].trim());
  if (out.length) return out;          /* tagged prompt: quotes are screen text */
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    if (SCREEN_TEXT.test(before)) continue;
    out.push(m[1].trim());
  }
  return out;
}

/* secs <= 0 表示调用方拿不到片段时长（文案台就没有画布/帧数）：那就别报时长，
   报一个必然是红的"台词超出片段时长"只会误导——它不是问题，是我们不知道。 */
export function promptCheck(prompt, totalSeconds) {
  const p = prompt || "";
  const clip = Math.max(0, +totalSeconds || 0);
  const rows = [];
  if (!p.trim()) return rows;

  /* 1. named fields */
  const missing = [];
  if (!FIELD_SOUND.test(p)) missing.push("overall_soundscape");
  if (!FIELD_MUSIC.test(p)) missing.push("non_diegetic_music");
  if (!FIELD_BODY.test(p) && missing.length === 2) {
    rows.push({ label: "格式", text: "未用命名字段，建议改用 overall_soundscape / non_diegetic_music / detailed_description 结构", state: "warn" });
  } else if (missing.length) {
    rows.push({ label: "格式", text: "缺少字段：" + missing.join("、"), state: "warn" });
  } else {
    rows.push({ label: "格式", text: "命名字段齐全", state: "ok" });
  }

  /* 2. dialogue and speaker id */
  const body = fieldText(p, "detailed_description")
            || fieldText(p, "integrated_multimodal_description")
            || p;
  const lines = spokenLines(body);
  if (!lines.length) {
    rows.push({ label: "对话", text: SILENT_INTENT.test(body) ? "已明确静默" : "无台词", state: "ok" });
  } else if (!SPEAKER_RE.test(body)) {
    rows.push({ label: "对话", text: `${lines.length} 句台词，缺说话人标注 (S1)`, state: "warn" });
  } else {
    rows.push({ label: "对话", text: `${lines.length} 句台词，已标说话人`, state: "ok" });
  }

  /* 3. mouths closed after the last line */
  if (lines.length) {
    rows.push(LIPS_RE.test(body)
      ? { label: "嘴唇", text: "台词结束后已提示合拢嘴唇", state: "ok" }
      : { label: "嘴唇", text: "台词后未提示闭嘴，H3 可能让角色继续张嘴，请补一句闭嘴描述", state: "warn" });
  }

  /* 4. how long the written lines take to say, at an average rate */
  if (lines.length && clip > 0) {
    const words = lines.join(" ").split(/\s+/).filter(Boolean).length;
    const spoken = words / WORDS_PER_SEC;
    const text = `台词约 ${spoken.toFixed(1)}s / 片段 ${clip.toFixed(1)}s`;
    rows.push(spoken > clip
      ? { label: "语音", text: text + " · 台词超出片段时长", state: "warn" }
      : { label: "语音", text, state: "ok" });
  }

  /* 5. soundscape covering the whole clip */
  const sound = fieldText(p, "overall_soundscape");
  if (sound === null) {
    rows.push({ label: "声音", text: "未填写整体音景 overall_soundscape", state: "warn" });
  } else {
    const w = sound.split(/\s+/).filter(Boolean).length;
    rows.push(w < 8
      ? { label: "声音", text: `音景描述仅 ${w} 词，偏单薄`, state: "warn" }
      : { label: "声音", text: `音景描述 ${w} 词`, state: "ok" });
  }

  return rows;
}
