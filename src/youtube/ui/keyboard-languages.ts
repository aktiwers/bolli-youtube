// The Search keyboard's languages, as YouTube's TV app has them (its "Select a search language"): each one's name as
// YouTube lists it, the language its suggestions come in (hl), its letters in YouTube's rows (Delete, &123 and the
// language key end the first three; · is a gap), the words on Space, Clear and Search and the field's hint, and how
// typing composes (Japanese kana marks, Korean syllables). Cantonese (Cangjie) is left out: its radicals need a
// dictionary to become characters. Also YouTube's numbers and symbols page, and the language for the TV's own.

export interface KeyboardLanguage {
    id: string;
    name: string;
    rows: string[];
    /** Space, Clear, Search, and the field's hint where it is not Search's word */
    words: string[];
    compose?: 'kana' | 'hangul';
}

var LATIN = ['abcdefg', 'hijklmn', 'opqrstu', "vwxyz-'"];
var NORDIC = ['abcdefgh', 'ijklmnop', 'qrstuvwx', "yzæøå-'"];
var SPANISH = ['abcdefg', 'hijklmn', 'ñopqrst', 'uvwxyz-'];
var SPANISH_WORDS = ['Espacio', 'Borrar', 'Buscar'];
var FRENCH_WORDS = ['Espace', 'Effacer', 'Rechercher'];

/** YouTube's order, English among the rest by name */
export var KEYBOARD_LANGUAGES: KeyboardLanguage[] = [
    { id: 'da', name: 'Dansk', rows: NORDIC, words: ['Mellemrum', 'Ryd', 'Søg'] },
    { id: 'de', name: 'Deutsch', rows: LATIN, words: ['Leerzeichen', 'Löschen', 'Suchen', 'Suche'] },
    { id: 'en', name: 'English (US)', rows: LATIN, words: ['Space', 'Clear', 'Search'] },
    { id: 'es', name: 'Español (España)', rows: SPANISH, words: SPANISH_WORDS },
    { id: 'es-419', name: 'Español (Latinoamérica)', rows: SPANISH, words: SPANISH_WORDS },
    { id: 'es-US', name: 'Español (US)', rows: SPANISH, words: SPANISH_WORDS },
    { id: 'fr', name: 'Français', rows: LATIN, words: FRENCH_WORDS },
    { id: 'fr-CA', name: 'Français (Canada)', rows: LATIN, words: FRENCH_WORDS },
    { id: 'it', name: 'Italiano', rows: LATIN, words: ['Spazio', 'Cancella', 'Cerca'] },
    { id: 'hu', name: 'Magyar', rows: LATIN, words: ['Szóköz', 'Törlés', 'Keresés'] },
    { id: 'nl', name: 'Nederlands', rows: LATIN, words: ['Spatie', 'Wissen', 'Zoeken'] },
    { id: 'no', name: 'Norsk', rows: NORDIC, words: ['Mellomrom', 'Tøm', 'Søk'] },
    { id: 'pl', name: 'Polski', rows: LATIN, words: ['Spacja', 'Wyczyść', 'Szukaj'] },
    { id: 'pt-PT', name: 'Português', rows: LATIN, words: ['Espaço', 'Limpar', 'Pesquisar', 'Pesquisa'] },
    { id: 'pt', name: 'Português (Brasil)', rows: LATIN, words: ['Espaço', 'Limpar', 'Pesquisar'] },
    { id: 'sv', name: 'Svenska', rows: ['abcdefgh', 'ijklmnop', 'qrstuvwx', "yzåäö-'"], words: ['Mellanslag', 'Rensa', 'Sök'] },
    { id: 'vi', name: 'Tiếng Việt', rows: LATIN, words: ['Dấu cách', 'Xóa', 'Tìm kiếm'] },
    { id: 'tr', name: 'Türkçe', rows: LATIN, words: ['Boşluk', 'Temizle', 'Ara', 'Arama'] },
    { id: 'ru', name: 'Русский', rows: ['абвгдежз', 'ийклмноп', 'рстуфхцч', 'шщъыьэюя'], words: ['Пробел', 'Очистить', 'Поиск'] },
    { id: 'uk', name: 'Українська', rows: ['абвгдеєж', 'зиіїйклм', 'нопрстуф', 'хцчшщьюя'], words: ['Пробіл', 'Очистити', 'Пошук'] },
    { id: 'el', name: 'Ελληνικά', rows: ['αβγδεζη', 'θικλμνξ', 'οπρστυφ', 'χψω'], words: ['Κενό διάστημα', 'Διαγραφή', 'Αναζήτηση'] },
    // (right to left: YouTube's rows read from the right, the side keys still at their ends)
    { id: 'iw', name: 'עברית', rows: ['זוהדגבא', 'מלךכיטח', 'ףפעסןנם', '-תשרקץצ'], words: ['רווח', 'ניקוי', 'חיפוש'] },
    { id: 'ar', name: 'العربية', rows: ['دخحجثتبا', 'طضصشسزرذ', 'ملكقفغعظ', '-ءةىيوهن'], words: ['مسافة', 'محو', 'بحث'] },
    { id: 'th', name: 'ภาษาไทย', rows: ['_ๅ/-ภถุึคตจขช', 'ๆไำพะัีรนยบลฃ', '·ฟหกดเ้่าสวง·', '·ผปแอิืทมใฝ···'], words: ['ช่องว่าง', 'ล้าง', 'ค้นหา'] },
    // (pinyin and zhuyin: YouTube's suggestions turn them into characters)
    { id: 'zh-CN', name: '中文 (简体)', rows: LATIN, words: ['空格', '清除', '搜索'] },
    { id: 'zh-TW', name: '中文 (繁體)', rows: ['ㄅㄉˉˊˇˋ˙ㄩㄝㄡㄥ', 'ㄆㄊㄍㄐㄓㄖㄙㄚㄞㄢㄦ', 'ㄇㄋㄎㄑㄔㄗㄧㄛㄟㄣ、', 'ㄈㄌㄏㄒㄕㄘㄨㄜㄠㄤ。'], words: ['空白鍵', '清除', '搜尋'] },
    { id: 'ja', name: '日本語', rows: ['あかさたなはまやらわ゛', 'いきしちにひみ·り·゜', 'うくすつぬふむゆるを小', 'えけせてねへめ·れ·ー', 'おこそとのほもよろん'], words: ['スペース', '削除', '検索'], compose: 'kana' },
    { id: 'ko', name: '한국어', rows: ['ㄱㄴㄷㄹㅁㅂㅅ', 'ㅇㅈㅊㅋㅌㅍㅎ', 'ㅏㅑㅓㅕㅗㅛㅜ', 'ㅠㅡㅣㅐㅒㅔㅖ'], words: ['스페이스', '지우기', '검색'], compose: 'hangul' }
];

/** YouTube's numbers and symbols (&123): Delete and ABC end the first two rows */
export var SYMBOLS = ['123&#()', '456@!?:', '789.-_"', '0/$%+[]'];

/** A gap in a row */
export var GAP = '·';

/** How many keyboard languages picked lately are kept */
var RECENT_MAX = 3;

/** The keyboard languages picked lately (recent) with id first (and left next) */
export function recentWith(recent: string[], id: string, left?: string): string[] {
    var rest = recent.filter(function (r) { return r !== id && r !== left; });
    return [id].concat(left && left !== id ? [left] : [], rest).slice(0, RECENT_MAX);
}

export function keyboardLanguage(id: string): KeyboardLanguage {
    return KEYBOARD_LANGUAGES.filter(function (l) { return l.id === id; })[0] || keyboardLanguage('en');
}

/** The keyboard for a device language (e.g. 'da-DK', 'pt-BR', 'he', 'zh-Hant-TW'): its own, else its language's, else
 * English */
export function keyboardFor(locale: string): string {
    var tag = (locale || '').replace(/_/g, '-').toLowerCase();
    var base = tag.split('-')[0];
    var exact = KEYBOARD_LANGUAGES.filter(function (l) { return l.id.toLowerCase() === tag; })[0];
    if (exact) {
        return exact.id;
    }
    // (Traditional for its script or for Taiwan, Hong Kong and Macau)
    if (base === 'zh') {
        return /\b(hant|tw|hk|mo)\b/.test(tag) ? 'zh-TW' : 'zh-CN';
    }
    var same: { [tag: string]: string } = { 'es-es': 'es', 'pt-br': 'pt', he: 'iw', nb: 'no', nn: 'no' };
    var alias = same[tag] || same[base];
    if (alias) {
        return alias;
    }
    // Latin America's Spanish for a country of its own (es-MX), Portugal's Portuguese only as pt-PT
    if (base === 'es' && tag !== 'es') {
        return 'es-419';
    }
    var first = KEYBOARD_LANGUAGES.filter(function (l) { return l.id.split('-')[0] === base; })[0];
    return first ? first.id : 'en';
}

// ---- composing

/** Kana and their marked forms, in pairs */
var DAKUTEN = 'かがきぎくぐけげこごさざしじすずせぜそぞただちぢつづてでとどはばひびふぶへべほぼうゔ';
var HANDAKUTEN = 'はぱひぴふぷへぺほぽ';
var SMALL = 'あぁいぃうぅえぇおぉやゃゆゅよょつっわゎ';

/** Hangul: initial consonants, vowels and finals in Unicode's order ('' no final), and the pairs that join */
var INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
var VOWELS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
var FINALS = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
var JOINED_VOWELS: { [pair: string]: string } = { 'ㅗㅏ': 'ㅘ', 'ㅗㅐ': 'ㅙ', 'ㅗㅣ': 'ㅚ', 'ㅜㅓ': 'ㅝ', 'ㅜㅔ': 'ㅞ', 'ㅜㅣ': 'ㅟ', 'ㅡㅣ': 'ㅢ' };
var JOINED_FINALS: { [pair: string]: string } = { 'ㄱㅅ': 'ㄳ', 'ㄴㅈ': 'ㄵ', 'ㄴㅎ': 'ㄶ', 'ㄹㄱ': 'ㄺ', 'ㄹㅁ': 'ㄻ', 'ㄹㅂ': 'ㄼ', 'ㄹㅅ': 'ㄽ', 'ㄹㅌ': 'ㄾ', 'ㄹㅍ': 'ㄿ', 'ㄹㅎ': 'ㅀ', 'ㅂㅅ': 'ㅄ' };
/** A consonant typed twice: its tense form (the keyboard has no key for those) */
var TENSE: { [plain: string]: string } = { 'ㄱ': 'ㄲ', 'ㄷ': 'ㄸ', 'ㅂ': 'ㅃ', 'ㅅ': 'ㅆ', 'ㅈ': 'ㅉ' };
var SYLLABLES = 0xac00;

/** text after key is typed in a language that composes: a kana mark (゛ ゜ 小) changes the kana before it (nothing
 * where it has no such form), a Hangul letter joins the syllable before it (a consonant typed twice: its tense form) */
export function composed(text: string, key: string, compose?: string): string {
    if (compose === 'kana' && (key === '゛' || key === '゜' || key === '小')) {
        return marked(text, key === '゛' ? DAKUTEN : key === '゜' ? HANDAKUTEN : SMALL);
    }
    if (compose === 'hangul') {
        return hangul(text, key);
    }
    return text + key;
}

/** The last kana in its form in pairs (one marked the other way first unmarked), or back from it */
function marked(text: string, pairs: string): string {
    var last = text.charAt(text.length - 1);
    var at = pairs.indexOf(last);
    if (at % 2 === 1) {
        return text.slice(0, -1) + pairs.charAt(at - 1);
    }
    at = pairs.indexOf(unmarked(last));
    return last && at >= 0 && at % 2 === 0 ? text.slice(0, -1) + pairs.charAt(at + 1) : text;
}

/** A kana without its voicing mark */
function unmarked(kana: string): string {
    var at = DAKUTEN.indexOf(kana);
    if (at % 2 === 1) {
        return DAKUTEN.charAt(at - 1);
    }
    at = HANDAKUTEN.indexOf(kana);
    return at % 2 === 1 ? HANDAKUTEN.charAt(at - 1) : kana;
}

/** text after Delete in a language that composes: Hangul loses its last letter (a final, a joined vowel's second half,
 * a tense consonant's doubling), else the last character goes */
export function erased(text: string, compose?: string): string {
    var last = text.charAt(text.length - 1);
    var head = text.slice(0, -1);
    if (compose !== 'hangul' || !last) {
        return head;
    }
    var plain = untense(last);
    if (plain) {
        return head + plain;
    }
    var code = last.charCodeAt(0) - SYLLABLES;
    if (code < 0 || code >= 11172) {
        return head;
    }
    var initial = Math.floor(code / 588);
    var vowel = Math.floor(code % 588 / 28);
    var final = code % 28;
    if (final) {
        var f = FINALS[final];
        var less = '';
        for (var pair in JOINED_FINALS) {
            if (JOINED_FINALS[pair] === f) {
                less = pair.charAt(0);
            }
        }
        return head + syllable(initial, vowel, FINALS.indexOf(less || untense(f) || ''));
    }
    for (var two in JOINED_VOWELS) {
        if (JOINED_VOWELS[two] === VOWELS.charAt(vowel)) {
            return head + syllable(initial, VOWELS.indexOf(two.charAt(0)), 0);
        }
    }
    return head + INITIALS.charAt(initial);
}

/** A tense consonant's plain one ('' not tense) */
function untense(c: string): string {
    for (var plain in TENSE) {
        if (TENSE[plain] === c) {
            return plain;
        }
    }
    return '';
}

function syllable(initial: number, vowel: number, final: number): string {
    return String.fromCharCode(SYLLABLES + (initial * 21 + vowel) * 28 + final);
}

function hangul(text: string, key: string): string {
    var last = text.charAt(text.length - 1);
    var head = text.slice(0, -1);
    var code = last ? last.charCodeAt(0) - SYLLABLES : -1;
    var inSyllable = code >= 0 && code < 11172;
    var initial = Math.floor(code / 588);
    var vowel = Math.floor(code % 588 / 28);
    var final = code % 28;
    if (VOWELS.indexOf(key) >= 0) {
        // A consonant alone, then a vowel: their syllable
        if (last && INITIALS.indexOf(last) >= 0) {
            return head + syllable(INITIALS.indexOf(last), VOWELS.indexOf(key), 0);
        }
        if (last && JOINED_VOWELS[last + key]) {
            return head + JOINED_VOWELS[last + key];
        }
        if (inSyllable && !final && JOINED_VOWELS[VOWELS.charAt(vowel) + key]) {
            return head + syllable(initial, VOWELS.indexOf(JOINED_VOWELS[VOWELS.charAt(vowel) + key]), 0);
        }
        // A syllable's final moves to begin the next one (a joined final splits: its second half moves)
        if (inSyllable && final) {
            var f = FINALS[final];
            var split = '';
            for (var pair in JOINED_FINALS) {
                if (JOINED_FINALS[pair] === f) {
                    split = pair;
                }
            }
            var stays = split ? FINALS.indexOf(split.charAt(0)) : 0;
            var moves = split ? split.charAt(1) : f;
            if (INITIALS.indexOf(moves) >= 0) {
                return head + syllable(initial, vowel, stays) + syllable(INITIALS.indexOf(moves), VOWELS.indexOf(key), 0);
            }
        }
        return text + key;
    }
    if (INITIALS.indexOf(key) >= 0) {
        var tense = TENSE[key];
        if (tense && last === key) {
            return head + tense;
        }
        // (a tense final where there is one, else the tense consonant begins the next syllable)
        if (tense && inSyllable && FINALS[final] === key) {
            return head + (FINALS.indexOf(tense) > 0 ? syllable(initial, vowel, FINALS.indexOf(tense)) : syllable(initial, vowel, 0) + tense);
        }
        if (inSyllable && !final && FINALS.indexOf(key) > 0) {
            return head + syllable(initial, vowel, FINALS.indexOf(key));
        }
        if (inSyllable && final && JOINED_FINALS[FINALS[final] + key]) {
            return head + syllable(initial, vowel, FINALS.indexOf(JOINED_FINALS[FINALS[final] + key]));
        }
    }
    return text + key;
}
