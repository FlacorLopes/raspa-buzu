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

export const PARIS_BEFORE = [
  'Bonjour! Tô em missão oficial. Qualquer coisa, manda áudio.',
  'Que horas são aí? Aqui já tá na hora do almoço.',
  'Aqui o ônibus passa a cada 4 minutos. Tô anotando tudo pra Salvador.',
  'O wi-fi do hotel tá lento. Se eu sumir, foi isso.',
  'Volto segunda. Segura as pontas aí.',
  'Comi um croissant que você nem acredita.',
];

export const PARIS_AFTER = [
  'Mandado de prisão?? Gente, tô no Louvre.',
  'Avisa à PF que meu voo é só amanhã.',
  'Calma. Até eu chegar, isso perde o objeto.',
  'Vou botar o celular no modo avião. Por segurança.',
];

export interface ClockEvent { at: number; text: string; unlock?: boolean; arrest?: boolean }

/** `at` is minutes since midnight on the in-game clock (06h00 to 17h00). */
export const EVENTS: ClockEvent[] = [
  { at: 360, text: '06h · Garagem aberta. Tem adesivo no para-brisa.' },
  { at: 570, text: '09h30 · Semob diz ter sido avisada da “adesivação”.' },
  { at: 665, text: '11h05 · Pedido à Justiça: ônibus ainda na garagem.' },
  { at: 740, text: '12h20 · Nova ordem: pode sair com adesivo!', unlock: true },
  { at: 800, text: 'TRE-BA: frota toda na rua, multa de R$ 1 mi por hora.' },
  { at: 860, text: 'TRE-BA manda a PF prender o secretário. Ele está em Paris.', arrest: true },
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
  [5, 'Raspador de Domingo'],
  [11, 'Espátula da Semob'],
  [18, 'Terror da Cola'],
  [26, 'Mais rápido que a Prefeitura'],
];

export function rankFor(score: number) {
  let title = RANKS[0][1];
  for (const [min, name] of RANKS) if (score >= min) title = name;
  return title;
}
