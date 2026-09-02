// A deliberately small PT-BR matcher — normalization, crude stemming, a
// synonym table, and token-overlap scoring. Not a real NLP pipeline: the
// KB provider's whole safety argument (Fase 8's design doc) rests on
// "never invents an answer," which a fuzzier matcher would undermine —
// every false-positive match is a wrong instruction handed to someone who
// doesn't know enough to spot it.

/** Lowercases and strips accents — "reiniciar", "reíniciar" and "REINICIAR" must all match the same token. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const STOPWORDS = new Set([
  'a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas',
  'um', 'uma', 'uns', 'umas', 'e', 'ou', 'que', 'com', 'para', 'por', 'meu', 'minha',
  'meus', 'minhas', 'eu', 'me', 'como', 'que', 'e', 'ao', 'aos', 'e', 'ser', 'esta', 'este',
  'isso', 'isso', 'la', 'ai', 'ali', 'aqui', 'tem', 'ter', 'e',
]);

// Crude suffix stripping — just enough to fold plurals and the most common
// verb conjugations onto a shared root ("instalar"/"instalando"/"instalei"
// all reduce toward "instal"), not a linguistically complete stemmer.
const SUFFIXES = ['ando', 'endo', 'indo', 'ei', 'ou', 'aram', 'eram', 'iram', 'ar', 'er', 'ir', 'es', 'is', 's'];

function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suf of SUFFIXES) {
    if (token.length - suf.length >= 3 && token.endsWith(suf)) {
      return token.slice(0, token.length - suf.length);
    }
  }
  return token;
}

// Maps a handful of common alternate phrasings onto one canonical token
// BEFORE stemming, so "ligar o server" and "iniciar o servidor" produce
// overlapping token sets even though "ligar" and "iniciar" don't share a
// stem. Deliberately small — a growing list belongs in each topic's own
// `keywords`, not here.
const SYNONYMS: Record<string, string> = {
  ligar: 'iniciar', startar: 'iniciar', comecar: 'iniciar', ligue: 'iniciar',
  inicio: 'iniciar', inicia: 'iniciar', iniciei: 'iniciar',
  desligar: 'parar', pausar: 'parar', pare: 'parar',
  travou: 'crash', crashou: 'crash', caiu: 'crash',
  addon: 'plugin', addons: 'plugin', complemento: 'plugin', complementos: 'plugin',
  jogadores: 'players', jogador: 'players',
  memoria: 'ram', server: 'servidor',
  // 1st/3rd-person present conjugations of the highest-traffic action
  // verbs — the stemmer's suffix list only handles the infinitive/-ar
  // family reliably, so "restauro um backup" needs an explicit bridge to
  // the "restaurar" root its topic's keywords are written in, same as
  // the iniciar entries above (found via kb-provider.spec.ts, not
  // guessed up front).
  restauro: 'restaurar', restaura: 'restaurar',
  instalo: 'instalar', instala: 'instalar',
  configuro: 'configurar', configura: 'configurar',
};

export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  const raw = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const t of raw) {
    if (STOPWORDS.has(t)) continue;
    const canon = SYNONYMS[t] ?? t;
    tokens.push(stem(canon));
  }
  return tokens;
}

/** Overlap score between a query's tokens and a topic's keyword-phrase tokens — count of shared stems, each keyword phrase counted once even if it contributes multiple shared tokens (a 3-word keyword phrase shouldn't outweigh three 1-word ones just by matching more tokens). */
export function scoreAgainstKeywords(queryTokens: string[], keywordPhrases: string[]): number {
  const querySet = new Set(queryTokens);
  let score = 0;
  for (const phrase of keywordPhrases) {
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length === 0) continue;
    const matched = phraseTokens.filter((t) => querySet.has(t)).length;
    if (matched === 0) continue;
    // Reward matching a larger fraction of a short, specific phrase more
    // than matching one token out of a long one.
    score += matched / phraseTokens.length;
  }
  return score;
}
