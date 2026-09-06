import { attachmentContentUrl } from "./api";
import type { Attachment } from "./types";

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_[\]{}<>!#|~]/g, "\\$&");
}

function codeSpan(value: string): string {
  if (!value) return "";
  // 内容中的反引号不能提前结束 code span；两侧留空格以保留原始边界。
  const fence = "`".repeat(Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)) + 1);
  return `${fence} ${value} ${fence}`;
}

function inlineMarkdown(value: string, attachments: Attachment[], monospace = false): string {
  const tokens = /\{\{(.+?)\}\}|\*([^*\n]+)\*|!([^!\n]+)!/g;
  let afterStrong = false;
  const plainText = (text: string): string => {
    if (monospace) return codeSpan(text);
    // CommonMark 不将“**背景：**正文”识别为粗体；实体保持原字符，同时分隔标记边界。
    if (afterStrong && /^[\p{L}\p{N}]/u.test(text)) {
      const first = Array.from(text)[0];
      return `&#${first.codePointAt(0)};${escapeMarkdown(text.slice(first.length))}`;
    }
    return escapeMarkdown(text);
  };
  let result = "";
  let offset = 0;
  for (const match of value.matchAll(tokens)) {
    result += plainText(value.slice(offset, match.index));
    if (match[1] !== undefined) {
      result += inlineMarkdown(match[1], attachments, true);
    } else if (match[2] !== undefined) {
      result += `**${inlineMarkdown(match[2], attachments, monospace)}**`;
    } else {
      const filename = match[3].split("|")[0].trim();
      const attachment = attachments.find((candidate) => (
        candidate.source === "jira"
        && candidate.filename === filename
        && candidate.contentType.startsWith("image/")
      ));
      // 只将本任务已同步的图片关联到认证下载入口，不把 Jira 原始地址交给浏览器。
      result += attachment
        ? `![${escapeMarkdown(filename)}](${attachmentContentUrl(attachment)})`
        : plainText(match[0]);
    }
    afterStrong = match[2] !== undefined;
    offset = match.index + match[0].length;
  }
  return result + plainText(value.slice(offset));
}

/**
 * 将 Jira 描述中使用的 Wiki 样式、嵌套列表和图片转为展示用 Markdown。
 * attachments 用于按文件名关联本任务图片；未匹配的图片标记保留原文。
 * 仅返回展示文本，不修改原始描述或附件，不能将结果用于向 Jira 保存。
 */
export function jiraDescriptionMarkdown(value: string, attachments: Attachment[]): string {
  // Jira 编辑器会在样式边界写入 {*} 和空 {}；仅处理明确的样式边界，保留正文花括号。
  const source = value.replace(/\r\n?/g, "\n")
    .replace(/\{\*\}/g, "*")
    .replace(/\{\{\{\}/g, "{{")
    .replace(/\{\}\}\}/g, "}}")
    .replace(/\}\}\{\{/g, "");
  return source.split("\n").map((line) => {
    const listItem = line.match(/^\s*(\*+)\s+(.*)$/);
    if (listItem) {
      return `${"  ".repeat(listItem[1].length - 1)}- ${inlineMarkdown(listItem[2], attachments)}`;
    }
    return inlineMarkdown(line, attachments);
  }).join("\n");
}
