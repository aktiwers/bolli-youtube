// Every language YouTube translates subtitles to, with its name (the list from YouTube's player reply), for
// Settings › Subtitles › "More languages" (ui/language-picker.ts) and subtitle and audio track names. In the app's
// other languages the names are that language's (lang/names/<code>.json: these languages', a few base languages'
// (Chinese) and the scripts' and regions' names by Unicode's CLDR, as Google names them, the languages in the order
// the language sorts them; written by tools/i18n.mjs --names), read once the first screen rests (prepareNames: ~4.5 ms
// on the TV), else when first needed; one CLDR lacks keeps its English name.

import { language, readJson } from '../core/i18n.js';
import { prefs } from './prefs.js';

export interface Language {
    code: string;
    name: string;
    /** Its English name (the picker finds it by that too: its keyboard has a-z) */
    english: string;
}

var ALL =
    'ab:Abkhazian|aa:Afar|af:Afrikaans|ak:Akan|sq:Albanian|am:Amharic|ar:Arabic|hy:Armenian|as:Assamese|' +
    'ay:Aymara|az:Azerbaijani|bn:Bangla|ba:Bashkir|eu:Basque|be:Belarusian|bho:Bhojpuri|bs:Bosnian|br:Breton|' +
    'bg:Bulgarian|my:Burmese|ca:Catalan|ceb:Cebuano|zh-Hans:Chinese (Simplified)|' +
    'zh-Hant:Chinese (Traditional)|co:Corsican|hr:Croatian|cs:Czech|da:Danish|dv:Divehi|nl:Dutch|dz:Dzongkha|' +
    'en:English|eo:Esperanto|et:Estonian|ee:Ewe|fo:Faroese|fj:Fijian|fil:Filipino|fi:Finnish|fr:French|gaa:Ga|' +
    'gl:Galician|lg:Ganda|ka:Georgian|de:German|el:Greek|gn:Guarani|gu:Gujarati|ht:Haitian Creole|ha:Hausa|' +
    'haw:Hawaiian|iw:Hebrew|hi:Hindi|hmn:Hmong|hu:Hungarian|is:Icelandic|ig:Igbo|id:Indonesian|iu:Inuktitut|' +
    'ga:Irish|it:Italian|ja:Japanese|jv:Javanese|kl:Kalaallisut|kn:Kannada|kk:Kazakh|kha:Khasi|km:Khmer|' +
    'rw:Kinyarwanda|ko:Korean|kri:Krio|ku:Kurdish|ky:Kyrgyz|lo:Lao|la:Latin|lv:Latvian|ln:Lingala|' +
    'lt:Lithuanian|lua:Luba-Lulua|luo:Luo|lb:Luxembourgish|mk:Macedonian|mg:Malagasy|ms:Malay|ml:Malayalam|' +
    'mt:Maltese|gv:Manx|mi:Māori|mr:Marathi|mn:Mongolian|mfe:Morisyen|ne:Nepali|new:Newari|nso:Northern Sotho|' +
    'no:Norwegian|ny:Nyanja|oc:Occitan|or:Odia|om:Oromo|os:Ossetic|pam:Pampanga|ps:Pashto|fa:Persian|' +
    'pl:Polish|pt:Portuguese|pt-PT:Portuguese (Portugal)|pa:Punjabi|qu:Quechua|ro:Romanian|rn:Rundi|' +
    'ru:Russian|sm:Samoan|sg:Sango|sa:Sanskrit|gd:Scottish Gaelic|sr:Serbian|crs:Seselwa Creole French|' +
    'sn:Shona|sd:Sindhi|si:Sinhala|sk:Slovak|sl:Slovenian|so:Somali|st:Southern Sotho|es:Spanish|su:Sundanese|' +
    'sw:Swahili|ss:Swati|sv:Swedish|tg:Tajik|ta:Tamil|tt:Tatar|te:Telugu|th:Thai|bo:Tibetan|ti:Tigrinya|' +
    'to:Tongan|ts:Tsonga|tn:Tswana|tum:Tumbuka|tr:Turkish|tk:Turkmen|uk:Ukrainian|ur:Urdu|ug:Uyghur|uz:Uzbek|' +
    've:Venda|vi:Vietnamese|war:Waray|cy:Welsh|fy:Western Frisian|wo:Wolof|xh:Xhosa|yi:Yiddish|yo:Yoruba|' +
    'zu:Zulu';

/** Subtitle languages always in Settings' list (and first in the player's) */
export var ALWAYS = ['da', 'en'];

var list: Language[] | null = null;
/** Their names and places in list by code (made with list) */
var byCode: { [code: string]: Language } = Object.create(null);
var order: { [code: string]: number } = Object.create(null);
/** The app language's names of base languages, scripts and regions by code (null: English, or none to read;
 * undefined: not read yet) */
var local: { languages: { [code: string]: string }; bases: { [code: string]: string }; scripts: { [code: string]: string };
    regions: { [code: string]: string } } | null | undefined;

function localNames(): typeof local {
    if (local === undefined) {
        var read = language() === 'en' ? null : readJson('lang/names/' + language() + '.json');
        local = read && read.languages && read.bases && read.scripts && read.regions ? read : null;
    }
    return local;
}

/** Reads the app language's names (main.ts: once the first screen rests), so a video's start finds them read */
export function prepareNames(): void {
    languages();
}

/** All languages, sorted by name (as YouTube lists them; in another app language as its names file has them, the
 * language's sort) */
export function languages(): Language[] {
    if (!list) {
        var all: Language[] = ALL.split('|').map(function (one) {
            var at = one.indexOf(':');
            return { code: one.slice(0, at), name: one.slice(at + 1), english: one.slice(at + 1) };
        });
        all.forEach(function (l) {
            byCode[l.code] = l;
        });
        var names = localNames();
        list = names ? Object.keys(names.languages).map(function (code) {
            var l = byCode[code];
            l.name = names!.languages[code];
            return l;
        }) : all;
        list.forEach(function (l, i) {
            order[l.code] = i;
        });
    }
    return list;
}

/** Settings' subtitle languages in order: Danish, English, those added from More languages, the current one */
export function subtitleLanguages(): string[] {
    return ALWAYS.concat(prefs().captionLanguages, [prefs().captions]).filter(function (code, i, all) {
        return !!code && all.indexOf(code) === i;
    });
}

/** The name of a language code: exact match, else its base's ("en-GB": English; in another app language a base that
 * stands for variants: "zh-TW": Chinese), else the first with that base ("zh": Chinese (Simplified)); unknown: '' */
function known(code: string): string {
    languages();
    var base = code.split('-')[0];
    var exact = byCode[code] || byCode[base];
    if (exact) {
        return exact.name;
    }
    var names = localNames();
    if (names && names.bases[base]) {
        return names.bases[base];
    }
    var first = list!.filter(function (l) { return l.code.split('-')[0] === base; })[0];
    return first ? first.name : '';
}

/** The name of a language code (unknown: the code itself) */
export function languageName(code: string): string {
    return known(code) || code;
}

/** Where a language comes in the list (its base's place for a variant; unknown: after all), for sorting tracks as the
 * app's language sorts their languages */
export function languageOrder(code: string): number {
    languages();
    var at = order[code];
    if (at === undefined) {
        at = order[code.split('-')[0]];
    }
    return at === undefined ? list!.length : at;
}

/** A subtitle or audio track's language in the app's language: its name, with the script and region its code names
 * in brackets ("en-GB": Engelsk (Storbritannien); "sr-Latn": Serbisk (latinsk); "zh-Hant-TW": Kinesisk (traditionelt,
 * Taiwan)), as YouTube names tracks; '' for a language not known here (the caller keeps YouTube's name) */
export function trackName(code: string): string {
    var name = known(code);
    var names = localNames();
    if (!name || !names || byCode[code]) {
        return name;
    }
    var more: string[] = [];
    code.split('-').slice(1).forEach(function (part) {
        var said = part.length === 4 ? names!.scripts[part] : names!.regions[part.toUpperCase()];
        if (said) {
            more.push(said);
        }
    });
    return more.length ? name + ' (' + more.join(', ') + ')' : name;
}
