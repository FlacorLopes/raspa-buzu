// Real Salvador bus lines (code + route) collected from meubuzu.com.br/linhas and
// Correio/onibus.online listings, 2026-10. The livery split follows the Integra basins:
// yellow = Plataforma (Subúrbio, the Garagem 5 operator), green = OT Trans (Miolo).
// Lines that used to belong to the old blue basin (Centro/Orla) were split between the two
// in 2020; their assignment here is approximate. Add lines freely: { code, led, livery }.

export type Livery = 'amarelo' | 'verde';

export interface Line {
  code: string;
  /** Text shown on the LED destination sign, short enough for the front display. */
  led: string;
  livery: Livery;
}

export const LINES: Line[] = [
  // Subúrbio / Cidade Baixa (Plataforma)
  { code: '0201', led: 'RIBEIRA / C. GRANDE', livery: 'amarelo' },
  { code: '0201', led: 'T. FRANÇA / RIBEIRA', livery: 'amarelo' },
  { code: '0203', led: 'RIBEIRA / PITUAÇU', livery: 'amarelo' },
  { code: '0203', led: 'L. DO TANQUE / PITUAÇU', livery: 'amarelo' },
  { code: '0205', led: 'MASSARANDUBA / S. PEDRO', livery: 'amarelo' },
  { code: '0205', led: 'T. FRANÇA / MASSARANDUBA', livery: 'amarelo' },
  { code: '0208', led: 'MASSARANDUBA / LAPA', livery: 'amarelo' },
  { code: '0116', led: 'LAPA / HGE', livery: 'amarelo' },
  { code: '0117', led: 'LAPA / BROTAS', livery: 'amarelo' },
  { code: '0120', led: 'BARBALHO / SALV. SHOPPING', livery: 'amarelo' },
  { code: '0136', led: 'LAPA / CHAME-CHAME', livery: 'amarelo' },
  { code: '0137', led: 'LAPA / BARRA', livery: 'amarelo' },
  { code: '0138', led: 'LAPA / ONDINA', livery: 'amarelo' },
  { code: '0140', led: 'LAPA / RIO VERMELHO', livery: 'amarelo' },
  { code: 'L101', led: 'BASE NAVAL / B. DO FISCAL', livery: 'amarelo' },
  { code: 'L108', led: 'VISTA ALEGRE / F. COUTOS', livery: 'amarelo' },
  { code: 'L117', led: 'PARIPE / NARANDIBA', livery: 'amarelo' },
  { code: 'L407', led: 'H. SUBÚRBIO / PERIPERI', livery: 'amarelo' },
  { code: 'L413', led: 'PERIPERI / SÃO CAETANO', livery: 'amarelo' },
  { code: 'E140', led: 'BASE NAVAL / L. RETIRO', livery: 'amarelo' },
  // Miolo (OT Trans)
  { code: '0125', led: 'P. S. CRISTÓVÃO / T. FRANÇA', livery: 'verde' },
  { code: '1053', led: 'MUSSURUNGA / BARRA', livery: 'verde' },
  { code: '1057', led: 'MUSSURUNGA / B. DA PAZ', livery: 'verde' },
  { code: '1078', led: 'MUSSURUNGA / STELLA MARIS', livery: 'verde' },
  { code: '1701', led: 'ÁGUAS CLARAS / CAJAZEIRAS', livery: 'verde' },
  { code: '1703', led: 'ÁGUAS CLARAS / CEASA', livery: 'verde' },
  { code: '1704', led: 'ÁGUAS CLARAS / B. DA MATA', livery: 'verde' },
  { code: '1705', led: 'ÁGUAS CLARAS / PALESTINA', livery: 'verde' },
  { code: '1723', led: 'ÁGUAS CLARAS / VALÉRIA', livery: 'verde' },
  { code: 'L501', led: 'CAJAZEIRA 11 / ITAPUÃ', livery: 'verde' },
  { code: 'L503', led: 'BOCA DA MATA / ITAPUÃ', livery: 'verde' },
];

export const YELLOW_LINES = LINES.filter((l) => l.livery === 'amarelo');
export const GREEN_LINES = LINES.filter((l) => l.livery === 'verde');
