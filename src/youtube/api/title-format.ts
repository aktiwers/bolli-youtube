// DeArrow's title tidying: Title Case, fewer capitals and exclamation marks, no emojis, fancy Unicode letters
// as plain ones. Ported from DeArrow (github.com/ajayyy/DeArrow, GPL-3.0), its title formatter with the default
// settings. Titles are taken as English: no language detection and no Turkish or Greek casing.
// A pure function of the title, run for every tile: word lists and patterns are built once, here.

type WordSet = { [word: string]: boolean };

/** The space-separated words as keys */
function wordSet(words: string): WordSet {
    var set: WordSet = Object.create(null);
    var list = words.split(' ');
    for (var i = 0; i < list.length; i++) {
        set[list[i]] = true;
    }
    return set;
}

/** Left lowercase inside a sentence */
var SMALL_WORDS = wordSet('a an the and but or nor for yet so as in of on to from into with w/ upon at by via vs v.s. vs. ' +
    'ft ft. feat feat. etc. etc');

/** Kept as written: names, units and acronyms the other rules would change */
var KEEP_WORDS = wordSet('NASA osu! PETA DEFCONConference DEFCON HDHR HDDT HDDTHR TUYU umu. MIMI S3RL NOMA DECO*27 EVO+ ' +
    'VINXIS IOSYS fhána LGBT LGBTQ LGBTQIA LGBTQ+IA LGBTQ2S BIPOC STFU TLDR TOTK BOTW SAINTCON TASBOT FNAF IANA OSHA NAFTA ' +
    'SCOTUS CPAN SWAT USAF ADHD IONOS NORAD UNHRC LDAC NVENC HEVC NVBFC IMAX CUDA VAAPI JPEG IETF zstd LZMA ANOVA HEIF HTML ' +
    'HDTV HDMI EULA GDPR CCPA HTTP HTTPS BIOS DMCA GUID JSON MIDI MMORPG OLED RHEL SFTP PCIe SSID UEFI UUID VRAM XMPP YAML ' +
    'OWSLA DJVI PSYQUI INZO MYRNE KNOWER PYLOT USAO TESV WRLD LAPD NYPD NVMe WYSIWYG TAS USSR Yu-Gi-Oh! II III IV VI VII ' +
    'VIII XIV XV XVI XVII XVIII VIA CCCP DIY SNES INTV PICO-8 PICO8 WSWAN PCE PCECD FPGA GTA TOOOL drawholic TF2 L4D L4D2 ' +
    'P/ECE CDROM CD-ROM EFF AAA IQ GEEKOM AI RVC DisplayPort BFDI BFDIA IDFB TPOT WWII CS2 CS:GO CSGO SCART ASMR CNBC mm cm ' +
    'km ft yd kg mg lb lbs oz mL gal m/s km/h mph ft/s in/s lbf cal kcal kW Hz kHz MHz GHz THz Pa kPa MPa GPa atm mmHg ' +
    'torr GPA ABC AFK AKA ASAP ATM BBC BC BCE BDSM BMW CCTV CD CIA CSS DC DLC DNA DPS DUI DVD DWI EMS ETA FAQ FBI FCC FDA ' +
    'FEMA FLOTUS FOMO FPS FTC GIF GPS HDD IRL IRS ISIL ISIS ISP JPG LAFD LCD LSD MBA MDMA MMA MMO MMR MMS MP3 MP4 NATO NBA ' +
    'NBC NFL NHL NHS NRA NSA NSFL NSFW NYC OCD OHS PDF PHP PMS PNG POTUS PTSD QR RLCS RPG RSVP SMS SQL SUV TV UFO UNGA URL ' +
    'USA USB USPS VCR VHS VIP VOD VPN WHS WWE WWF WWI XML LGBTQIA2S+ NVFBC DALL-E DALL·E iilluminaughtii TOML DJ SPTV VST ' +
    'EQ JWST HP STM ESP TCP TCP/IP FTP UDP DSKY DRO MCSR ELO GT:NH');

/** Game map name prefixes (de_dust2), kept as written; besides these, words starting with osu! */
var KEEP_STARTS = wordSet('de_ cs_ ar_ as_ es_ dz_ fy_ aim_ zm_ jail_ bb_ gg_ awp_ df_ deathrun_');

/** Short words in capitals that are shouting, not acronyms */
var NOT_ACRONYMS = wordSet('not see be you are is it of the to new end won sue day fly so one two six ten can pro why did ' +
    'now too bad big all old');

/** Abbreviations whose dot does not end a sentence */
var NOT_SENTENCE_ENDS = wordSet('v.s. vs. ft. feat. mr. mrs. ms. dr. prof. sr. jr.');

/** Brackets and colons around a word, ignored when looking it up in a list */
var BRACKETS = /[[「〈《【〔⦗『〖〘<({:〙〗』⦘〕】》〉」)}\]]/g;
/** Punctuation trimmed off a word before looking it up again (one end only) */
var EDGE_PUNCTUATION = /[:?.!+\]]+$|^[[+:/]+/;
var COMPOUND = /.-.|.\/./;
var GREEK = /[Ͱ-Ͽ]/;
var YEAR = /^[「〈《【〔⦗『〖〘<({["'‘]*[0-9]{2,4}'?s[〙〗』⦘〕】》〉」)}\]"']*$/;
var NUMBER_START = /^[「〈《【〔⦗『〖〘<({["'‘]*[0-9]+/;
/** The part of U.S.A after anything not a letter */
var DOTTED = /^(?:\S\.)+\S?$/;
var LONE_DELIMITER = /^[-:;~—–|]$/;
var SENTENCE_END = /[:?.!\]]$/;
var MARKER = /(^|\s)>(\S)/g;

/** A title without the > marks that keep a word's case (as DeArrow shows one untidied) */
export function unmark(title: string): string {
    return title.replace(MARKER, '$1$2');
}

/** Letters without case (counted as capitals, as in DeArrow): phonetic and modifier letters, right-to-left, Indic and
 * Southeast Asian scripts, Ethiopic, Canadian syllabics, Mongolian, kana, CJK, Yi, Hangul and others */
var CASELESS_LETTER = new RegExp('[\\u0180-\\u02C1\\u02C6-\\u02D1\\u02E0-\\u02E4\\u02EC\\u02EE\\u05D0-\\u05F2' +
    '\\u0620-\\u064A\\u066E-\\u06D3\\u06D5\\u06E5\\u06E6\\u06EE\\u06EF\\u06FA-\\u06FF\\u0710-\\u08FF' +
    '\\u0904-\\u0DFF\\u0E01-\\u0E46\\u0E81-\\u0EC6\\u0F00\\u0F40-\\u0F6C\\u0F88-\\u0F8C\\u1000-\\u109F' +
    '\\u1100-\\u138F\\u1401-\\u166C\\u166F-\\u167F\\u1681-\\u169A\\u16A0-\\u16EA\\u1700-\\u17B3\\u17D7' +
    '\\u17DC\\u1820-\\u18AA\\u1900-\\u1AA7\\u1B05-\\u1C7D\\u1CE9-\\u1CFA\\u1D00-\\u1DBF\\u2071\\u207F' +
    '\\u2090-\\u209C\\u2D30-\\u2D6F\\u2D80-\\u2DDE\\u3005\\u3006\\u3031-\\u3035\\u303B\\u303C\\u3041-\\u3096' +
    '\\u309D-\\u309F\\u30A1-\\u30FA\\u30FC-\\u30FF\\u3105-\\u312F\\u3131-\\u318E\\u31A0-\\u31BF\\u31F0-\\u31FF' +
    '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uA000-\\uA48C\\uA4D0-\\uA4FD\\uA500-\\uA60C\\uA6A0-\\uA6E5\\uA717-\\uA71F' +
    '\\uA788\\uA78F\\uA7F7-\\uA7FF\\uA800-\\uABFF\\uAC00-\\uD7FB\\uF900-\\uFAFF\\uFB1D-\\uFDFF\\uFE70-\\uFEFC' +
    '\\uFF66-\\uFFDC]');

/** One emoji (Unicode's Extended_Pictographic and ☆), but not 🅰 🆎 🅱 🆑 🅾, which stand for letters */
var EMOJI = '(?:[\\u00A9\\u00AE\\u203C\\u2049\\u2122\\u2139\\u2194-\\u2199\\u21A9\\u21AA\\u231A\\u231B\\u2328\\u23CF' +
    '\\u23E9-\\u23F3\\u23F8-\\u23FA\\u24C2\\u25AA\\u25AB\\u25B6\\u25C0\\u25FB-\\u25FE\\u2600-\\u2604\\u2606\\u260E\\u2611' +
    '\\u2614\\u2615\\u2618\\u261D\\u2620\\u2622\\u2623\\u2626\\u262A\\u262E\\u262F\\u2638-\\u263A\\u2640\\u2642' +
    '\\u2648-\\u2653\\u265F\\u2660\\u2663\\u2665\\u2666\\u2668\\u267B\\u267E\\u267F\\u2692-\\u2697\\u2699\\u269B\\u269C' +
    '\\u26A0\\u26A1\\u26A7\\u26AA\\u26AB\\u26B0\\u26B1\\u26BD\\u26BE\\u26C4\\u26C5\\u26C8\\u26CE\\u26CF\\u26D1\\u26D3' +
    '\\u26D4\\u26E9\\u26EA\\u26F0-\\u26F5\\u26F7-\\u26FA\\u26FD\\u2702\\u2705\\u2708-\\u270D\\u270F\\u2712\\u2714\\u2716' +
    '\\u271D\\u2721\\u2728\\u2733\\u2734\\u2744\\u2747\\u274C\\u274E\\u2753-\\u2755\\u2757\\u2763\\u2764\\u2795-\\u2797' +
    '\\u27A1\\u27B0\\u27BF\\u2934\\u2935\\u2B05-\\u2B07\\u2B1B\\u2B1C\\u2B50\\u2B55\\u3030\\u303D\\u3297\\u3299]' +
    '|\\uD83C[\\uDC04\\uDC2C-\\uDC2F\\uDC94-\\uDC9F\\uDCAF\\uDCB0\\uDCC0\\uDCCF\\uDCD0\\uDCF6-\\uDCFF\\uDD7F' +
    '\\uDD92-\\uDD9A\\uDDAE-\\uDDE5\\uDE01-\\uDE0F\\uDE1A\\uDE2F\\uDE32-\\uDE3A\\uDE3C-\\uDE3F\\uDE49-\\uDE5F' +
    '\\uDE66-\\uDF21\\uDF24-\\uDF93\\uDF96\\uDF97\\uDF99-\\uDF9B\\uDF9E-\\uDFF0\\uDFF3-\\uDFF5\\uDFF7-\\uDFFA]' +
    '|\\uD83D[\\uDC00-\\uDCFD\\uDCFF-\\uDD3D\\uDD49-\\uDD4E\\uDD50-\\uDD67\\uDD6F\\uDD70\\uDD73-\\uDD7A\\uDD87' +
    '\\uDD8A-\\uDD8D\\uDD90\\uDD95\\uDD96\\uDDA4\\uDDA5\\uDDA8\\uDDB1\\uDDB2\\uDDBC\\uDDC2-\\uDDC4\\uDDD1-\\uDDD3' +
    '\\uDDDC-\\uDDDE\\uDDE1\\uDDE3\\uDDE8\\uDDEF\\uDDF3\\uDDFA-\\uDE4F\\uDE80-\\uDEC5\\uDECB-\\uDED2\\uDED5-\\uDEE5' +
    '\\uDEE9\\uDEEB-\\uDEF0\\uDEF3-\\uDEFF\\uDFDA-\\uDFFF]' +
    '|\\uD83E[\\uDC0C-\\uDC0F\\uDC48-\\uDC4F\\uDC5A-\\uDC5F\\uDC88-\\uDC8F\\uDCAE\\uDCAF\\uDCBC-\\uDCBF\\uDCC2-\\uDCCF' +
    '\\uDCD9-\\uDCFF\\uDD0C-\\uDD3A\\uDD3C-\\uDD45\\uDD47-\\uDDFF\\uDE58-\\uDE5F\\uDE6E-\\uDEFF]' +
    '|\\uD83F[\\uDC00-\\uDFFD])';
/** An emoji with its variation selectors, skin tones and joiners */
var EMOJI_CLUSTER = EMOJI + '(?:[\\uFE0E\\uFE0F\\u200D]|\\uD83C[\\uDFFB-\\uDFFF])*';
var ANY_EMOJI = new RegExp(EMOJI);
var EMOJIS_BETWEEN_SPACES = new RegExp(' (?:' + EMOJI_CLUSTER + ')+(?= )', 'g');
var EMOJIS = new RegExp('(?:' + EMOJI_CLUSTER + ')+', 'g');
var SELECTOR_THEN_EMOJI = new RegExp('[\\uFE0E\\uFE0F]' + EMOJI);

/** Styled letters and digits (𝐁𝐨𝐥𝐝, ｗｉｄｅ, Ⓒⓘⓡⓒⓛⓔⓓ, ①) in blocks: first and last code point, then the plain characters
 * they go through (repeating) or the first number */
var UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
var LOWER = 'abcdefghijklmnopqrstuvwxyz';
var DIGITS = '0123456789';
var FANCY_RANGES: [number, number, string | number][] = [
    [0x1D400, 0x1D6A3, UPPER + LOWER], [0x1D7CE, 0x1D7FF, DIGITS], [0xFF10, 0xFF19, DIGITS], [0xFF21, 0xFF3A, UPPER],
    [0xFF41, 0xFF5A, LOWER], [0x24B6, 0x24CF, UPPER], [0x24D0, 0x24E9, LOWER], [0x249C, 0x24B5, LOWER],
    [0x1F110, 0x1F129, UPPER], [0x1F130, 0x1F149, UPPER], [0x1F150, 0x1F169, UPPER], [0x1F170, 0x1F189, UPPER],
    [0x2080, 0x2089, 0], [0x1F101, 0x1F10A, 0], [0x2460, 0x2473, 1], [0x2474, 0x2487, 1], [0x2488, 0x249B, 1],
    [0x24EB, 0x24F4, 11], [0x24F5, 0x24FE, 1], [0x2776, 0x277F, 1], [0x2780, 0x2789, 1], [0x278A, 0x2793, 1]
];

/** The other styled letters and digits, by character */
var FANCY: { [char: string]: string } = Object.create(null);

(function () {
    // Each line the plain character and then the code points standing for it
    var others = [
        '0 24FF 24EA 1F100 1F10B 1F10C', '1 2960', '5 1BC',
        'A 1D6A8 1D71C 1D756 1D790 1D6E2 1D2C 1D00', 'a 237A 251 2376 AA 1D6C2 1D736 1D770 1D7AA 1D6FC 1D43 1D45 2090',
        'B 1D6A9 1D71D 1D757 1D791 212C 1D6E3 1D2E 10784 299', 'b 1D47',
        'C 2102 212D A7F2 1D04', 'c 1F74C 217D 1D9C', 'D 2145 18A 1D30 1D05', 'd 2146 257 1F1A5 1D48',
        'E 1D6AC 1D720 1D75A 1D794 2130 1D6E6 1D31 1D07', 'e AB32 212E 212F 1D49 2091',
        'F 1D7CA 2131 A7F3 A730', 'f AB35 A799 1E9D 192 1DA0', 'G 1D33 10792 262', 'g 1DA2 261 210A 1D4D',
        'H 1D6AE 1D722 1D75C 1D796 210B 1D6E8 210D 210C 1D34 10796 29C', 'h 210E 2B0 2095',
        'I 2160 1D6B0 1D724 1D75E 1D798 2110 1D6EA 2111 1D35 1DA6 26A', 'i 2148 2071 1D62',
        'J 1D36 1D0A', 'j 29D 1D6A5 2149 2B2 2C7C', 'K 138 198 212A 1D6B1 1D725 1D75F 1D799 1D6EB 1D37 1D0B',
        'k 1D4F 2096', 'L 2112 1D38 1DAB 29F', 'l 2113 2E1 2097',
        'M 216F 1D6B3 1D727 1D761 1D79B 2133 1D6ED 1D39 1D0D', 'm 217F 1D50 2098',
        'N 1D6B4 1D728 1D762 1D79C 1D6EE 2115 1D3A 1DB0 274', 'n 207F 2099',
        'O 1D6B6 1D72A 1D764 1D79E 1D6F0 1D3C 1D0F', 'o 1D6D0 1D744 1D77E 1D7B8 2134 1D70A 1D52 2092',
        'P 1A4 1D6B8 1D72C 1D766 1D7A0 2118 1D6F2 2119 1D3E 1D18', 'p 1BF 2374 2117 1D56 209A',
        'Q 211A A7F4 A7AF', 'q 107A5', 'R 211B 211D 211C 1D3F 107AA 280', 'r AB47 2B3 1D63',
        'S 1F12A A731', 's 2E2 209B', 'T 1F768 1D6BB 1D72F 1D769 1D7A3 1D6F5 1D40 1D1B', 't 1D57 209C',
        'U 1D41 1DB8 1D1C', 'u 1D6D6 1D74A 1D784 1D7BE 1D710 1D58 1DB7 1D64', 'V 2164 2C7D 1D20',
        'v 2174 1D6CE 1D742 1D77C 1D7B6 1D708 1D5B 1D65', 'W 1D42 1D21', 'w 2B7',
        'X 2169 2573 1D6BE 1D732 1D76C 1D7A6 1D6F8', 'x 1D6D8 1D712 1D786 2179 1D74C 1D7C0 2E3 1D61 2093',
        'Y 1D6BC 1D730 1D76A 1D7A4 1D6F6 107B2 28F', 'y 1EFF AB5A 1B4 1D6C4 1D738 1D772 1D7AC 1D6FE 213D 2B8 2E0',
        'Z 1D6AD 1D721 1D75B 1D795 1D6E7 2124 2128 1D22', 'z 1DBB'
    ];
    for (var i = 0; i < others.length; i++) {
        var line = others[i].split(' ');
        for (var j = 1; j < line.length; j++) {
            FANCY[fromCodePoint(parseInt(line[j], 16))] = line[0];
        }
    }
})();

function fromCodePoint(cp: number): string {
    if (cp < 0x10000) {
        return String.fromCharCode(cp);
    }
    cp -= 0x10000;
    return String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
}

/** title as DeArrow's Title Case shows it; custom: a title DeArrow's users submitted (its capitals are trusted more)
 * rather than YouTube's own */
export function tidyTitle(title: string, custom: boolean): string {
    return toTitleCase(cleanFancyText(cleanEmojis(title)), custom);
}

function toTitleCase(title: string, custom: boolean): string {
    var words = title.split(' ');
    var shouting = isMostlyAllCaps(words);
    var result = '';
    for (var i = 0; i < words.length; i++) {
        var word = wordToTitleCase(words[i], i, words, custom, shouting);
        if (word.length > 0) {
            result += word + ' ';
        }
    }
    return cleanPunctuation(result).replace(MARKER, '$1$2').trim();
}

function wordToTitleCase(word: string, index: number, words: string[], custom: boolean, shouting: boolean): string {
    if (forceKeepFormatting(word, true) || YEAR.test(word) || GREEK.test(word)) {
        return word;
    }
    if (COMPOUND.test(word)) {
        // Hyphenated or slashed: each part as a word of its own
        var parts = word.split(/([-/])/);
        var inWords = words.slice(0, index).concat(word.split(/[-/]/), words.slice(index + 1));
        var result = '';
        for (var i = 0; i < parts.length; i++) {
            result += i % 2 ? parts[i] : wordToTitleCase(parts[i], index + i / 2, inWords, custom, shouting);
        }
        return result;
    }
    var inner = isWordCustomCapitalization(word);
    if ((custom && inner) || ((inner || isNumberThenLetter(word)) && !isAllCaps(word))) {
        // Capitals past the first letter (iPhone) and 3rd stay, unless all caps in YouTube's own title
        return word;
    }
    if (listHasWord(SMALL_WORDS, word.toLowerCase()) && !startOfSentence(index, words) && !endOfSentence(index, words)) {
        return word.toLowerCase();
    }
    if (isFirstLetterCapital(word) && ((isAcronym(word) && shouldTrustCaps(shouting, words, index)) || isAcronymStrict(word))) {
        return word;
    }
    return capitalizeFirstLetter(word);
}

/** Capitals are trusted unless most of the title, or a word next to this one, is in all caps */
function shouldTrustCaps(shouting: boolean, words: string[], index: number): boolean {
    var shouted = function (word: string | undefined): boolean { return isAllCaps(word) && !forceKeepFormatting(word as string, true); };
    return !shouting && !shouted(words[index - 1]) && !shouted(words[index + 1]);
}

/** More than half the words are in all caps */
function isMostlyAllCaps(words: string[]): boolean {
    var count = 0;
    for (var i = 0; i < words.length; i++) {
        if (isAllCaps(words[i])) {
            count++;
        }
    }
    return count > words.length * 0.5;
}

/** Has a letter and none in lowercase; U.S.A and USB-C are not all caps, HANDS-ON is */
function isAllCaps(word: string | undefined): boolean {
    if (!word || word.toUpperCase() !== word || firstLetter(word) < 0 || isAcronymStrict(word)) {
        return false;
    }
    var letters = 0;
    while (letters < 4 && letters < word.length && letterAt(word, letters)) {
        letters++;
    }
    var next = word.charAt(letters);
    return !(letters >= 1 && letters <= 3 && (next === '-' || next === '~' || next === '—'));
}

/** 2: an uppercase letter at i, 1: another letter, 0: not a letter (characters outside the BMP count as not letters) */
function letterAt(s: string, i: number): number {
    var c = s.charCodeAt(i);
    if (c < 0x80) {
        return c >= 65 && c <= 90 ? 2 : (c >= 97 && c <= 122 ? 1 : 0);
    }
    if (c < 0x100) {
        // Latin-1: À to Þ uppercase, ß to ÿ lowercase, but × and ÷; ª µ º
        if (c >= 0xC0) {
            return c === 0xD7 || c === 0xF7 ? 0 : (c <= 0xDE ? 2 : 1);
        }
        return c === 0xAA || c === 0xB5 || c === 0xBA ? 1 : 0;
    }
    if ((c >= 0x2160 && c <= 0x24FF) || (c >= 0xD800 && c <= 0xDFFF)) {
        // Roman numerals and circled letters have case without being letters
        return 0;
    }
    var ch = s.charAt(i);
    var upper = ch.toUpperCase();
    if (upper !== ch.toLowerCase()) {
        return upper === ch ? 2 : 1;
    }
    return CASELESS_LETTER.test(ch) ? 1 : 0;
}

/** Index of the first letter, -1 if none */
function firstLetter(word: string): number {
    for (var i = 0; i < word.length; i++) {
        if (letterAt(word, i)) {
            return i;
        }
    }
    return -1;
}

function isFirstLetterCapital(word: string): boolean {
    var i = firstLetter(word);
    return i >= 0 && letterAt(word, i) === 2;
}

function hasCapital(word: string): boolean {
    for (var i = 0; i < word.length; i++) {
        if (letterAt(word, i) === 2) {
            return true;
        }
    }
    return false;
}

/** Uppercase first letter and lowercase rest */
function capitalizeFirstLetter(word: string): string {
    if (startsWithEmojiLetter(word)) {
        return word.toLowerCase();
    }
    var i = firstLetter(word);
    return i < 0 ? word : word.substring(0, i) + word.charAt(i).toUpperCase() + word.substring(i + 1).toLowerCase();
}

/** Starts with 🅰 🆎 🅱 🆑 or 🅾 (already a capital) followed by no capitals */
function startsWithEmojiLetter(word: string): boolean {
    for (var i = 0; i < word.length; i++) {
        if (word.charCodeAt(i) === 0xD83C && isEmojiLetter(word.charCodeAt(i + 1))) {
            var rest = word.substring(i + 2);
            if (rest && !hasCapital(rest)) {
                return true;
            }
        } else if (letterAt(word, i)) {
            return false;
        }
    }
    return false;
}

/** The low surrogate of 🅰 🆎 🅱 🆑 or 🅾 */
function isEmojiLetter(low: number): boolean {
    return low === 0xDD70 || low === 0xDD71 || low === 0xDD7E || low === 0xDD8E || low === 0xDD91;
}

/** Has capitals besides the first letter (iPhone, AirPods); a compound word in any of its parts */
function isWordCustomCapitalization(word: string): boolean {
    if (COMPOUND.test(word)) {
        var parts = word.split(/[-/]/);
        for (var p = 0; p < parts.length; p++) {
            if (isWordCustomCapitalization(parts[p])) {
                return true;
            }
        }
        return false;
    }
    var capitals = 0;
    var first = 0;
    for (var i = 0; i < word.length; i++) {
        var kind = letterAt(word, i);
        if (kind && !first) {
            first = kind;
        }
        if (kind === 2) {
            capitals++;
        }
    }
    return capitals > 1 || (capitals === 1 && first !== 2);
}

/** 3rd, 45th, (2nd */
function isNumberThenLetter(word: string): boolean {
    var number = NUMBER_START.exec(word);
    return !!number && letterAt(word, number[0].length) > 0;
}

/** Kept as written: marked with '>', listed (also with punctuation around it), a hashtag or a subreddit */
function forceKeepFormatting(word: string, ignorePunctuation: boolean): boolean {
    var c = word.charAt(0);
    if (c === '>' || (c === '#' && !isAllCaps(word)) || word.lastIndexOf('r/', 0) === 0
        || listHasWord(KEEP_WORDS, word) || listHasStartOfWord(word)) {
        return true;
    }
    if (ignorePunctuation && word && (':?.!+]'.indexOf(word.charAt(word.length - 1)) >= 0 || '[+:/'.indexOf(c) >= 0)) {
        var bare = word.replace(EDGE_PUNCTUATION, '');
        return bare !== word && listHasWord(KEEP_WORDS, bare);
    }
    return false;
}

function listHasWord(list: WordSet, word: string): boolean {
    return list[unbracketed(word)] === true;
}

/** The word without brackets and colons (a loop first: most words have none) */
function unbracketed(word: string): string {
    for (var i = 0; i < word.length; i++) {
        var c = word.charCodeAt(i);
        if (c === 0x28 || c === 0x29 || c === 0x3A || c === 0x3C || c === 0x5B || c === 0x5D || c === 0x7B || c === 0x7D
            || c >= 0x2997) {
            return word.replace(BRACKETS, '');
        }
    }
    return word;
}

/** Starts with osu! or a game map prefix */
function listHasStartOfWord(word: string): boolean {
    if (word.indexOf('_') < 0 && word.indexOf('osu!') < 0) {
        return false;
    }
    word = unbracketed(word);
    var cut = word.indexOf('_');
    return word.lastIndexOf('osu!', 0) === 0 || (cut > 0 && KEEP_STARTS[word.substring(0, cut + 1)] === true);
}

/** Two or three letters in capitals (not a common word), or letters with dots */
function isAcronym(word: string): boolean {
    return ((word.length <= 3 || countLetters(word) <= 3) && word.length > 1 && isAllCaps(word)
        && !listHasWord(NOT_ACRONYMS, word.toLowerCase())) || isAcronymStrict(word);
}

/** How many letters word has */
function countLetters(word: string): number {
    var count = 0;
    for (var i = 0; i < word.length; i++) {
        if (letterAt(word, i)) {
            count++;
        }
    }
    return count;
}

/** Letters with dots: U.S.A, U.S. (after anything not a letter) */
function isAcronymStrict(word: string): boolean {
    if (word.indexOf('.') < 0) {
        return false;
    }
    for (var i = 0; i < word.length; i++) {
        if (DOTTED.test(i ? word.substring(i) : word)) {
            return true;
        }
        if (letterAt(word, i)) {
            return false;
        }
    }
    return false;
}

function startOfSentence(index: number, words: string[]): boolean {
    return index === 0 || isDelimeter(words[index - 1]);
}

function endOfSentence(index: number, words: string[]): boolean {
    return index === words.length - 1 || isDelimeter(words[index])
        || (!!words[index + 1] && LONE_DELIMITER.test(words[index + 1]));
}

/** Ends a sentence: a lone dash, colon or bar, or a word ending in : ? . ! ] that is not an abbreviation (vs., U.S.) */
function isDelimeter(word: string): boolean {
    return (LONE_DELIMITER.test(word) || SENTENCE_END.test(word))
        && !listHasWord(KEEP_WORDS, word)
        && !listHasWord(NOT_SENTENCE_ENDS, word.toLowerCase())
        && (word.charAt(word.length - 1) !== '.' || !isAcronymStrict(word));
}

/** Trailing ! and . dropped and ? runs as one ?, at the end of the title and of words inside it ("Wow!" before more
 * words: "Wow.") */
function cleanPunctuation(title: string): string {
    var words = cleanWordPunctuation(title).split(' ');
    var result = '';
    for (var i = 0; i < words.length; i++) {
        var word = words[i];
        var question = word.indexOf('?') >= 0;
        if ((question || word.charAt(word.length - 1) === '!') && i !== words.length - 1 && !forceKeepFormatting(word, false)) {
            if (question) {
                word = cleanWordPunctuation(word);
            } else {
                var period = words.length > i + 1 && !isDelimeter(words[i + 1]);
                word = cleanWordPunctuation(word);
                if (word === '!' || word === '.') {
                    // Marks standing alone end the word before them instead
                    if (period && result) {
                        result = result.substring(0, result.length - 1) + '. ';
                    }
                    word = '';
                } else if (period) {
                    word += '.';
                }
            }
        }
        word = word.trim();
        if (word.length > 0) {
            result += word + ' ';
        }
    }
    return result.trim();
}

/** Trailing ! . and spaces dropped, one ? if there was any (marks alone: a single ? or the first mark); listed words
 * and U.S.A. style endings left as they are */
function cleanWordPunctuation(title: string): string {
    var trimmed = title.trim();
    var last = trimmed.substring(trimmed.lastIndexOf(' ') + 1);
    if (forceKeepFormatting(last, false) || (last.charAt(last.length - 1) === '.' && isAcronymStrict(last))) {
        return title;
    }
    var end = title.length - 1;
    var question = false;
    for (; end >= 0; end--) {
        var c = title.charAt(end);
        if (c === '?') {
            question = true;
        } else if (c !== '!' && c !== '.' && c !== ' ') {
            break;
        }
    }
    if (end < 0) {
        return question ? '?' : title.charAt(0);
    }
    return title.substring(0, end + 1) + (question ? '?' : '');
}

/** Emojis dropped (a space where they stood between letters); a title of only emojis stays */
function cleanEmojis(title: string): string {
    if (!ANY_EMOJI.test(title)) {
        return title;
    }
    var cleaned = title.replace(EMOJIS_BETWEEN_SPACES, '').replace(EMOJIS, function (run: string, at: number, s: string) {
        // Before a letter: a space if a letter comes before, or a variation selector inside the run (as DeArrow's
        // pattern, which may start at one)
        return letterAfter(s, at + run.length) && (letterBefore(s, at) || SELECTOR_THEN_EMOJI.test(run)) ? ' ' : '';
    }).trim();
    return cleaned.length > 0 ? cleaned : title;
}

/** A letter (mathematical ones too), variation selector, 🆎 or 🆑 just before i */
function letterBefore(s: string, i: number): boolean {
    var c = s.charCodeAt(i - 1);
    if (c === 0xFE0E || c === 0xFE0F) {
        return true;
    }
    if (c >= 0xDC00 && c <= 0xDFFF) {
        var high = s.charCodeAt(i - 2);
        return (high === 0xD83C && (c === 0xDD8E || c === 0xDD91)) || (high === 0xD835 && c <= 0xDFCB);
    }
    return i > 0 && letterAt(s, i - 1) > 0;
}

/** A letter (mathematical ones too), 🅰 🆎 🅱 🆑 or 🅾 at i */
function letterAfter(s: string, i: number): boolean {
    var c = s.charCodeAt(i);
    if (c === 0xD83C) {
        return isEmojiLetter(s.charCodeAt(i + 1));
    }
    if (c === 0xD835) {
        return s.charCodeAt(i + 1) <= 0xDFCB;
    }
    return letterAt(s, i) > 0;
}

/** Styled letters and digits as plain ones; a variation selector on either side goes too (🅱️) */
function cleanFancyText(title: string): string {
    var out = '';
    var copied = 0;
    for (var i = 0; i < title.length; i++) {
        var c = title.charCodeAt(i);
        if (c < 0xAA) {
            continue;
        }
        var size = c >= 0xD800 && c <= 0xDBFF ? 2 : 1;
        var cp = size === 2 ? 0x10000 + ((c - 0xD800) << 10) + title.charCodeAt(i + 1) - 0xDC00 : c;
        var plain = plainOf(title.substring(i, i + size), cp);
        if (plain === undefined) {
            i += size - 1;
            continue;
        }
        var start = i;
        var end = i + size;
        start -= selectorBefore(title, start, copied);
        end += isSelector(title, end);
        out += title.substring(copied, start) + plain;
        copied = end;
        i = end - 1;
    }
    return (copied ? out + title.substring(copied) : title).trim();
}

/** The plain letter or digit a styled character (code point cp) stands for, undefined if none */
function plainOf(ch: string, cp: number): string | undefined {
    var plain = FANCY[ch];
    if (plain !== undefined || cp < 0x2080 || (cp > 0x2793 && cp < 0xFF10) || (cp > 0xFF5A && cp < 0x1D400)) {
        return plain;
    }
    for (var r = 0; r < FANCY_RANGES.length; r++) {
        var range = FANCY_RANGES[r];
        if (cp >= range[0] && cp <= range[1]) {
            var to = range[2];
            var k = cp - range[0];
            return typeof to === 'string' ? to.charAt(k % to.length) : String(to + k);
        }
    }
    return undefined;
}

/** Length of a variation selector ending at i and not before from, else 0 */
function selectorBefore(s: string, i: number, from: number): number {
    if (i - 1 >= from && isSelector(s, i - 1) === 1) {
        return 1;
    }
    return i - 2 >= from && isSelector(s, i - 2) === 2 ? 2 : 0;
}

/** 1 for U+FE00 to U+FE0F at i, 2 for U+E0100 to U+E01EF, else 0 */
function isSelector(s: string, i: number): number {
    var c = s.charCodeAt(i);
    if (c >= 0xFE00 && c <= 0xFE0F) {
        return 1;
    }
    if (c === 0xDB40) {
        var low = s.charCodeAt(i + 1);
        return low >= 0xDD00 && low <= 0xDDEF ? 2 : 0;
    }
    return 0;
}
