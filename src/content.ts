// Copy shared by the touch and camera modes. The in-game "secretário" messages are fiction
// and the pages label them as satire; the clock events follow the reporting linked on the pages.

export interface Decoy { text: string; bg: string; fg: string; edge: string; toast: string }

/** Non-candidate stickers: scraping them costs a point. Index matches BusSpec.decoy. */
export const DECOYS: Decoy[] = [
  { text: 'BORA BAHÊA', bg: '#1b4fa0', fg: '#ffffff', edge: '#d4251c', toast: 'Adesivo do Bahêa pode, viu?' },
  { text: 'DEUS É FIEL', bg: '#ffffff', fg: '#1b3f8f', edge: '#1b3f8f', toast: 'Esse não ameaça a democracia.' },
  { text: 'ACARAJÉ 10/10', bg: '#f5c518', fg: '#5a2a0a', edge: '#5a2a0a', toast: 'Propaganda de acarajé tá liberada.' },
  { text: 'ME RESPEITE', bg: '#111111', fg: '#f5c518', edge: '#f5c518', toast: 'Esse aí é patrimônio baiano.' },
];

export const ACCESS_TOAST = 'Esse é o de acessibilidade. É obrigatório!';

// Fictional texts from the absent secretary (he really was in Paris on an official mission).
export const PARIS_BEFORE = [
  'Bonjour! Tô em missão oficial. Qualquer coisa, manda áudio.',
  'Que horas são aí? Aqui já tá na hora do almoço.',
  'Aqui o ônibus passa a cada 4 minutos. Tô anotando tudo pra Salvador.',
  'O wi-fi do hotel tá lento. Se eu sumir, foi isso.',
  'Comi um croissant que você nem acredita.',
  'Fui no Louvre. A Mona Lisa não tem adesivo nenhum. Liberada.',
  'Aqui o ônibus sai com propaganda de perfume e ninguém liga.',
  'Liberté, égalité, adesivité.',
  'Tô numa reunião sobre mobilidade. A dos outros, no caso.',
  'Me mandaram foto da garagem cheia. Achei que era estacionamento de shopping.',
  'Tô aprendendo francês: "le bus est dans le garage".',
  'Vou trazer uma espátula de lembrança pra equipe.',
  'Deixei o carregador no Brasil. Junto com a frota.',
  'Volto segunda. Segura as pontas aí.',
];

export const PARIS_AFTER = [
  'Mandado de prisão?? Gente, tô no Louvre.',
  'Avisa à PF que meu voo é só amanhã.',
  'Calma. Até eu chegar, isso perde o objeto.',
  'Vou botar o celular no modo avião. Por segurança.',
  'O voo de volta tem conexão. Igual ônibus em Salvador: demora retada.',
  'Alguém liga pro prefeito? Ele não atende o francês.',
];

/** Toasts when a bus with no 13 sticker goes out: it could have left all along. */
export const CLEAN_BUS_TOASTS = [
  'Esse nem tinha adesivo. Baratino!',
  'Sem adesivo e parado. Que baratino é esse?',
  'Limpinho desde as 6h. O baratino sobe.',
  'Sem 13, sem desculpa. Só baratino.',
  'Adesivo nenhum. Baratino da Semob +1.',
];

/**
 * Baratinômetro levels, in Bahian slang for a flimsy excuse ("baratino"). Driven by the number
 * of buses with no 13 sticker the player releases: each one makes the sticker excuse flimsier.
 */
export const BARATINO_LEVELS: [number, string][] = [
  [1, 'Migué'],
  [4, 'Quatchá quatchá'],
  [7, 'Baratino master'],
];

/** Level name for a clean-bus count, or '' before the first one. */
export function baratinoLevel(cleanBuses: number) {
  let name = '';
  for (const [min, label] of BARATINO_LEVELS) if (cleanBuses >= min) name = label;
  return name;
}

/** Background beat and its required credit (free for non-monetised use, credit mandatory). */
export const MUSIC_CREDIT_SHORT = 'Beat: Bloquinho Hitmado · EMBeat';
export const MUSIC_CREDIT_SHARE = '🎹 Beat: Bloquinho Hitmado – EMBeat (@esdrassmiranda_)';

export interface ClockEvent { at: number; text: string; unlock?: boolean; arrest?: boolean }

/** `at` is minutes since midnight on the in-game clock (06h00 to 17h00). */
export const EVENTS: ClockEvent[] = [
  { at: 360, text: '06h · Garagem aberta. A prefeitura prometeu a frota toda na rua.' },
  { at: 470, text: 'Ponto lotado, garagem lotada. Motoristas oferecem carona solidária.' },
  { at: 570, text: '09h30 · Semob diz que o problema é um adesivo no para-brisa.' },
  { at: 620, text: 'Semob: a frota foi a mesma do 1º turno. Então não era o adesivo?' },
  { at: 665, text: '11h05 · Pedido à Justiça: ônibus ainda na garagem.' },
  { at: 700, text: 'Procon-BA: 944 ônibus parados em 9 garagens. Na G5, 64.' },
  { at: 740, text: '12h20 · Semob diz que normalizou. Pode sair com adesivo!', unlock: true },
  { at: 775, text: 'Bruno Reis: tirar adesivo atrasou a operação.' },
  { at: 815, text: 'TRE-BA: frota toda na rua, multa de R$ 1 mi por hora.' },
  { at: 875, text: 'TRE-BA manda a PF prender o secretário. Ele está em Paris.', arrest: true },
  { at: 930, text: '15h30 · Rui Costa filma garagem no Subúrbio: “São centenas de ônibus”.' },
];

export const CLOCK_START = 6 * 60;
export const CLOCK_SPAN = 11 * 60;

export function clockMinutes(elapsedMs: number, gameMs: number) {
  return CLOCK_START + Math.min(1, elapsedMs / gameMs) * CLOCK_SPAN;
}

export function clockText(minutes: number) {
  const h = Math.floor(minutes / 60), m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export const RANKS: [number, string][] = [
  [0, 'Estagiário em Paris'],
  [8, 'Fiscal de Domingo'],
  [15, 'Espátula da Semob'],
  [22, 'Terror da Burocracia'],
  [30, 'Mais rápido que a Prefeitura'],
];

export function rankFor(score: number) {
  let title = RANKS[0][1];
  for (const [min, name] of RANKS) if (score >= min) title = name;
  return title;
}
