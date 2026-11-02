// Every language YouTube translates subtitles to, with its name (the list from YouTube's player reply), for
// Settings › Subtitles › "More languages" (ui/language-picker.ts) and subtitle track names.

import { prefs } from './prefs.js';

export interface Language {
    code: string;
    name: string;
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

/** All languages, sorted by name (as YouTube lists them) */
export function languages(): Language[] {
    if (!list) {
        list = ALL.split('|').map(function (one) {
            var at = one.indexOf(':');
            return { code: one.slice(0, at), name: one.slice(at + 1) };
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

/** The name of a language code: exact match, else its base ("en-GB": English), else the first with that base
 * ("zh": Chinese (Simplified)); unknown: the code itself */
export function languageName(code: string): string {
    var base = code.split('-')[0];
    var found = find(function (l) { return l.code === code; }) || find(function (l) { return l.code === base; }) ||
        find(function (l) { return l.code.split('-')[0] === base; });
    return found ? found.name : code;
}

function find(test: (l: Language) => boolean): Language | null {
    return languages().filter(test)[0] || null;
}
