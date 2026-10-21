// 読み取った名刺の文字を、名前・会社・電話などの欄に振り分ける
// （名刺の文字はこのiPhoneの中だけで処理し、どこにも送らない）

const JA = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}ー々〒';
const CIRCLED = '⓪①②③④⑤⑥⑦⑧⑨';

function toHalfWidth(s) {
  return s
    .replace(/[０-９Ａ-Ｚａ-ｚ＠．－：／＿＋（）]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[⓪①-⑨]/g, c => String(CIRCLED.indexOf(c)))
    .replace(/[‐‑‒–—―ー−](?=\d)/g, '-')
    .replace(/　/g, ' ')
    // 読み取りソフトが日本語の文字の間に入れる空白を取る（「株 式 会 社」→「株式会社」）
    .replace(new RegExp(`([${JA}])[ \\t]+(?=[${JA}])`, 'gu'), '$1')
    // 「.cojp」のように点が抜けたドメインを直す
    .replace(/\.(co|ne|or|ac|go)\s?jp\b/g, '.$1.jp')
    .replace(/(@[A-Za-z0-9-]+)(com|net|org)\b/g, '$1.$2');
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
    // 名刺のふちなどを読んだ、意味のない短い行を捨てる
    .filter(l => l && !(l.length <= 4 && !new RegExp(`[${JA}]{2}|\\d{2}`, 'u').test(l)));

  const rest = [];
  const addr = [];

  for (let line of lines) {
    let used = false;

    const email = line.match(RE_EMAIL);
    if (email && !out.email) { out.email = email[0]; line = line.replace(email[0], ''); used = true; }

    // 1行に「TEL 03-… FAX 03-… 携帯 090-…」と並ぶこともあるので、番号ごとに直前のラベルを見る
    const phones = [...line.matchAll(new RegExp(RE_PHONE.source, 'g'))].filter(m => m[0].replace(/\D/g, '').length >= 10);
    if (phones.length) {
      let from = 0;
      for (const m of phones) {
        const label = line.slice(from, m.index);
        from = m.index + m[0].length;
        if (/(FAX|Fax|fax|ファクス|ファックス|(^|\s)F\s*[.:：]?\s*$)/.test(label)) continue;
        const num = cleanPhone(m[0]);
        const mobile = /(Mobile|MOBILE|携帯|Cell|(^|\s)M\s*[.:：]?\s*$)/.test(label) || /^(\+81[\s-]?)?0?[789]0/.test(m[0].replace(/^\+81[\s-]?/, '0'));
        if (mobile && !out.mobile) out.mobile = num;
        else if (!mobile && !out.tel) out.tel = num;
        else if (!out.mobile) out.mobile = num;
      }
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
