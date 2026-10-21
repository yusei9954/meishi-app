// 読み取った名刺の文字を、名前・会社・電話などの欄に振り分ける
// （名刺の文字はこのiPhoneの中だけで処理し、どこにも送らない）

function toHalfWidth(s) {
  return s
    .replace(/[０-９Ａ-Ｚａ-ｚ＠．－：／＿＋（）]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[‐‑‒–—―ー−](?=\d)/g, '-')
    .replace(/　/g, ' ');
}

const RE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const RE_URL = /(https?:\/\/[^\s]+|www\.[^\s]+|[A-Za-z0-9-]+\.(?:co\.jp|or\.jp|ne\.jp|ac\.jp|go\.jp|jp|com|net|org|biz|info)(?:\/[^\s]*)?)/i;
const RE_PHONE = /(?:\+81[\s-]?)?\(?0\d{1,4}\)?[\s-]?\d{1,4}[\s-]?\d{3,4}/;
const RE_POSTAL = /(〒\s*\d{3}-?\d{4}|(?<![\d-])\d{3}-\d{4}(?![\d-]))/;
const RE_PREF = /(北海道|東京都|大阪府|京都府|.{2,3}県)/;
const RE_ADDR = /(都|道|府|県|市|区|町|村|丁目|番地|ビル|F\b|階)/;
const RE_COMPANY = /(株式会社|有限会社|合同会社|合資会社|一般社団法人|公益社団法人|一般財団法人|特定非営利活動法人|NPO法人|医療法人|社会福祉法人|学校法人|\(株\)|㈱|\(有\)|㈲|事務所|協会|組合|大学|病院|クリニック|銀行|Inc\.?|Co\.,?|Ltd\.?|LLC|Corporation|Company)/i;
const RE_TITLE = /(代表|取締役|社長|会長|部長|課長|係長|主任|室長|所長|店長|支店長|理事|顧問|マネージャー|マネジャー|リーダー|ディレクター|プロデューサー|エンジニア|デザイナー|コンサルタント|担当|営業|部|課|室|グループ|チーム|CEO|CTO|COO|CFO|Manager|Director|President|Engineer|Designer)/i;
// 1文字のラベル（T. や E: など）は、うしろに記号があるときだけラベルとみなす
const RE_LABEL = /^((TEL|Tel|tel|電話|☎|℡|FAX|Fax|fax|Mobile|MOBILE|携帯|E-?mail|E-?MAIL|Mail|MAIL|URL|Web|WEB|HP)\s*[.:：]?|[TFME]\s*[.:：])\s*/;

function cleanPhone(s) {
  return s.replace(/[()\s]/g, m => (m === ' ' ? '-' : '')).replace(/-+/g, '-');
}

function parseCard(raw) {
  const out = { name: '', company: '', title: '', tel: '', mobile: '', email: '', url: '', address: '' };
  const lines = toHalfWidth(raw)
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const rest = [];
  const addr = [];

  for (let line of lines) {
    let used = false;

    const email = line.match(RE_EMAIL);
    if (email && !out.email) { out.email = email[0]; line = line.replace(email[0], ''); used = true; }

    const isFax = /^(FAX|Fax|fax|F)\s*[.:：]/.test(line);
    const isMobile = /^(Mobile|MOBILE|携帯|M)\s*[.:：]/.test(line) || /(^|\D)0[789]0[\s-]?\d{4}[\s-]?\d{4}/.test(line);
    const phone = line.match(RE_PHONE);
    if (phone && phone[0].replace(/\D/g, '').length >= 10) {
      if (!isFax) {
        const num = cleanPhone(phone[0]);
        if (isMobile && !out.mobile) out.mobile = num;
        else if (!out.tel) out.tel = num;
        else if (!out.mobile) out.mobile = num;
      }
      // 同じ行にFAXが続く場合（TEL 03-… FAX 03-…）は、TELだけ取る
      used = true;
      line = '';
    }

    if (!used || line) {
      const url = line.match(RE_URL);
      if (url && !out.url && !RE_EMAIL.test(url[0])) { out.url = url[0]; line = line.replace(url[0], ''); used = true; }
    }

    line = line.replace(RE_LABEL, '').trim();
    if (!line) continue;

    if (RE_POSTAL.test(line) || (RE_PREF.test(line) && RE_ADDR.test(line)) || (addr.length && /\d/.test(line) && RE_ADDR.test(line))) {
      addr.push(line);
      continue;
    }
    rest.push(line);
  }

  out.address = addr.join(' ');

  const remaining = [];
  for (const line of rest) {
    if (!out.company && RE_COMPANY.test(line)) { out.company = line; continue; }
    if (RE_TITLE.test(line) && line.length <= 30 && !out.title) { out.title = line; continue; }
    if (RE_TITLE.test(line) && line.length <= 30) { out.title += ' ' + line; continue; }
    remaining.push(line);
  }

  // 名前：残った行のうち、短くて記号や数字がない行（姓と名のあいだに空白がある行を優先）
  const nameLike = remaining.filter(l => l.length >= 2 && l.length <= 16 && !/[\d@/:]/.test(l));
  const pick = nameLike.find(l => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+\s+[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(l))
    || nameLike.find(l => /^[\p{Script=Han}]{2,6}$/u.test(l))
    || nameLike[0];
  if (pick) out.name = pick;

  if (!out.company) {
    const other = remaining.find(l => l !== pick && l.length >= 2);
    if (other) out.company = other;
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { parseCard };
