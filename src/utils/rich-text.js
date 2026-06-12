/**
 * Rich Text Converter
 *
 * Converts source platform rich text to ServiceNow HTML:
 *   - Jira ADF (Atlassian Document Format) JSON → SN HTML
 *   - Salesforce HTML → SN HTML (sanitize/normalize)
 *   - Plain text → SN HTML (wrap in <p>)
 */

// ── ADF (Jira) → HTML ──────────────────────────────────────────────────────
export function adfToHtml(adf) {
  if (!adf) return '';
  if (typeof adf === 'string') {
    try { adf = JSON.parse(adf); } catch { return escapeHtml(adf); }
  }
  if (adf.type !== 'doc') return escapeHtml(String(adf));
  return (adf.content ?? []).map(renderNode).join('');
}

function renderNode(node) {
  if (!node) return '';
  switch (node.type) {
    case 'paragraph':
      return `<p>${renderChildren(node)}</p>`;
    case 'heading':
      return `<h${node.attrs?.level ?? 2}>${renderChildren(node)}</h${node.attrs?.level ?? 2}>`;
    case 'bulletList':
      return `<ul>${renderChildren(node)}</ul>`;
    case 'orderedList':
      return `<ol>${renderChildren(node)}</ol>`;
    case 'listItem':
      return `<li>${renderChildren(node)}</li>`;
    case 'blockquote':
      return `<blockquote>${renderChildren(node)}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${escapeHtml(textContent(node))}</code></pre>`;
    case 'rule':
      return '<hr/>';
    case 'hardBreak':
      return '<br/>';
    case 'text':
      return applyMarks(escapeHtml(node.text ?? ''), node.marks ?? []);
    case 'mention':
      return `<span class="mention">@${escapeHtml(node.attrs?.text ?? node.attrs?.id ?? '')}</span>`;
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard':
    case 'blockCard': {
      const url = node.attrs?.url ?? '';
      return `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`;
    }
    case 'media':
    case 'mediaGroup':
    case 'mediaSingle':
      return `<p>[Attachment: ${escapeHtml(node.attrs?.alt ?? node.attrs?.id ?? 'file')}]</p>`;
    case 'table':
      return `<table>${renderChildren(node)}</table>`;
    case 'tableRow':
      return `<tr>${renderChildren(node)}</tr>`;
    case 'tableHeader':
      return `<th>${renderChildren(node)}</th>`;
    case 'tableCell':
      return `<td>${renderChildren(node)}</td>`;
    default:
      return renderChildren(node);
  }
}

function renderChildren(node) {
  return (node.content ?? []).map(renderNode).join('');
}

function textContent(node) {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(textContent).join('');
}

function applyMarks(text, marks) {
  return marks.reduce((acc, mark) => {
    switch (mark.type) {
      case 'strong':    return `<strong>${acc}</strong>`;
      case 'em':        return `<em>${acc}</em>`;
      case 'underline': return `<u>${acc}</u>`;
      case 'strike':    return `<s>${acc}</s>`;
      case 'code':      return `<code>${acc}</code>`;
      case 'link':      return `<a href="${escapeAttr(mark.attrs?.href ?? '')}">${acc}</a>`;
      case 'textColor': return `<span style="color:${escapeAttr(mark.attrs?.color ?? '')}">${acc}</span>`;
      default:          return acc;
    }
  }, text);
}

// ── Salesforce HTML → SN HTML ──────────────────────────────────────────────
// Salesforce HTML is mostly standard; strip dangerous attributes/elements,
// normalize whitespace, replace SF-specific tags.
const ALLOWED_TAGS   = new Set(['p','div','span','br','hr','b','strong','i','em','u','s',
  'del','strike','a','ul','ol','li','blockquote','pre','code','table','thead','tbody',
  'tr','th','td','h1','h2','h3','h4','h5','h6','img']);
const SAFE_ATTRS     = new Set(['href','src','alt','title','class','style','width','height',
  'colspan','rowspan','align','valign']);
const DANGEROUS_TAGS = /^(script|style|iframe|object|embed|form|input|button|select|textarea)$/i;

export function sfHtmlToSnHtml(html) {
  if (!html) return '';
  if (typeof html !== 'string') return escapeHtml(String(html));

  // Remove script/style/iframe blocks entirely
  let out = html.replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Remove dangerous tags but keep their content
  out = out.replace(/<\/?(?:script|style|iframe|object|embed|form|input|button)[^>]*>/gi, '');

  // Strip event handlers from all tags
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');

  // Strip javascript: URLs
  out = out.replace(/href\s*=\s*["']?\s*javascript:[^"'\s>]*/gi, 'href="#"');

  // Replace Salesforce-specific data-* attribute containers with simple spans
  out = out.replace(/<[a-z][a-z0-9]*\s[^>]*data-sfdc[^>]*>/gi, '<span>');

  return out.trim();
}

// ── Plain text → HTML ──────────────────────────────────────────────────────
export function textToHtml(text) {
  if (!text) return '';
  return escapeHtml(String(text))
    .split('\n\n')
    .map(para => `<p>${para.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

// ── Auto-detect and convert ────────────────────────────────────────────────
export function toSnHtml(value, hint = 'auto') {
  if (!value) return '';
  if (hint === 'adf')       return adfToHtml(value);
  if (hint === 'sf_html')   return sfHtmlToSnHtml(value);
  if (hint === 'text')      return textToHtml(value);

  // Auto-detect
  if (typeof value === 'object') return adfToHtml(value);
  if (typeof value === 'string') {
    if (value.trim().startsWith('{') && value.includes('"type"')) {
      try { const parsed = JSON.parse(value); return adfToHtml(parsed); } catch { /* fall through */ }
    }
    if (/<[a-z][\s\S]*>/i.test(value)) return sfHtmlToSnHtml(value);
    return textToHtml(value);
  }
  return escapeHtml(String(value));
}

// ── Helpers ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
