/**
 * Motor de cálculo do bridge de EBITDA a partir de dados brutos
 * (quantidade e montante), reproduzindo as fórmulas da aba "Cálculo"
 * do Modelo Bridge.xlsx. Todos os efeitos são calculados na hora da
 * comparação origem → destino.
 *
 * Referência das fórmulas (linhas da aba Cálculo):
 *  - Preço de venda: por produto, preço = montante/qtd; efeito USD
 *    P = (pT − pB) × qtdT / 1000 (col. P). Para produtos BRL o efeito é
 *    calculado em moeda local M = (pT·fxT − pB·fxB) × qtdT / 1000 / fxB
 *    (cols. L/M); a diferença vs USD pertence ao câmbio.
 *  - Volume & Mix: margem de contribuição m = preço venda − custo variável
 *    unitário (base origem). Qtd a mix constante J = totT × qtdB / totB.
 *    Mix = (qtdT − J) × mB / 1000 (cols. I dos blocos 17-47 e 50-80);
 *    Vol&Mix K = (qtdT − qtdB) × mB / 1000; Volume = K − Mix (cols. K/L 83-113).
 *  - Custo fixo: por categoria, FC forex I = amtT × (fxT/fxB − 1) (zero para
 *    categorias USD); efeito J = amtB − amtT − I (linhas 116-124).
 *  - Preço de insumos: itens precificados J = (pB − pT) × rendimento ×
 *    produção de aço bruto (linhas 128-134); itens diretos = nívelT − nívelB.
 *  - Câmbio: receita doméstica destino × (1 − fxT/fxB) + custo doméstico
 *    destino × (1 − fxT/fxB) (linhas 149-153).
 *  - Consumo / Others: nívelT − nívelB por linha (147, 155+).
 *  - Variação de estoque: plug de fechamento ΔEBITDA − demais alavancas
 *    (linha 12: C12 = C13 − SUM(C3:C11)).
 */
import type {
  ScenarioParams,
  SalesFact,
  FixedCostFact,
  InputPriceFact,
  MiscFact,
} from "@workspace/db";

export interface RawScenarioData {
  params: ScenarioParams;
  sales: SalesFact[];
  fixed: FixedCostFact[];
  inputs: InputPriceFact[];
  misc: MiscFact[];
}

export interface DetailLine {
  label: string;
  group: string | null;
  value: number; // MUSD
  sortOrder: number;
}

export interface BridgeResult {
  start: number; // MUSD
  end: number; // MUSD
  drivers: Record<string, number>; // MUSD por alavanca
  details: Record<string, DetailLine[]>;
}

const K = 1000; // kUSD -> MUSD

function unitPrice(amountKusd: number, qtyKt: number): number {
  return qtyKt !== 0 ? (amountKusd / qtyKt) * 1000 : 0; // USD/t
}

export function computeBridge(
  source: RawScenarioData,
  target: RawScenarioData,
): BridgeResult {
  const fxB = source.params.fxRate;
  const fxT = target.params.fxRate;
  // Câmbio próprio do bloco de custo fixo (cai no geral quando não informado).
  const fcFxB = source.params.fcFxRate || fxB;
  const fcFxT = target.params.fcFxRate || fxT;

  // ---------- vendas: preço, câmbio (parte analítica), volume & mix ----------
  const byKey = new Map<
    string,
    { b?: SalesFact; t?: SalesFact; label: string; sortOrder: number }
  >();
  for (const s of source.sales) {
    byKey.set(s.productKey, { b: s, label: s.label, sortOrder: s.sortOrder });
  }
  for (const s of target.sales) {
    const e = byKey.get(s.productKey);
    if (e) e.t = s;
    else byKey.set(s.productKey, { t: s, label: s.label, sortOrder: s.sortOrder });
  }

  const totQtyB = source.sales.reduce((s, r) => s + r.qtyKt, 0);
  const totQtyT = target.sales.reduce((s, r) => s + r.qtyKt, 0);

  let sellingPrice = 0;
  let volume = 0;
  let mixTotal = 0;
  let volMixTotal = 0;
  const priceLines: DetailLine[] = [];
  const volMixLines: DetailLine[] = [];

  for (const { b, t, label, sortOrder } of byKey.values()) {
    const qtyB = b?.qtyKt ?? 0;
    const qtyT = t?.qtyKt ?? 0;
    // Produtos sem quantidade em um dos cenários usam o preço/custo unitário
    // do outro como referência (aba Cálculo faz o mesmo: D27=G27 quando C27=0,
    // e o custo variável unitário vem da coluna D do bloco 50-80). Assim um
    // produto novo não gera efeito de preço artificial — só volume/mix e câmbio.
    const rawPB = unitPrice(b?.amountKusd ?? 0, qtyB);
    const rawPT = unitPrice(t?.amountKusd ?? 0, qtyT);
    const pB = qtyB !== 0 ? rawPB : rawPT;
    const pT = qtyT !== 0 ? rawPT : rawPB;
    const rawCB = unitPrice(b?.varCostKusd ?? 0, qtyB);
    const cB = qtyB !== 0 ? rawCB : unitPrice(t?.varCostKusd ?? 0, qtyT);
    const currency = (t ?? b)?.currency ?? "USD";

    // Preço de venda (col. M): BRL para mercado doméstico, USD para o resto.
    const priceUsd = ((pT - pB) * qtyT) / 1000; // kUSD (col. P)
    const price =
      currency === "BRL" && fxB !== 0
        ? ((pT * fxT - pB * fxB) * qtyT) / 1000 / fxB
        : priceUsd;
    sellingPrice += price;
    if (Math.abs(price) > 1e-9) {
      priceLines.push({ label, group: "Por produto", value: price / K, sortOrder });
    }

    // Volume & Mix sobre margem de contribuição (base origem).
    const mB = pB - cB;
    const constMixQty = totQtyB !== 0 ? (totQtyT * qtyB) / totQtyB : 0; // col. J
    const mix = ((qtyT - constMixQty) * mB) / 1000; // I17 + I50
    const volMix = ((qtyT - qtyB) * mB) / 1000; // col. K
    mixTotal += mix;
    volMixTotal += volMix;
    volume += volMix - mix; // col. L
    if (Math.abs(volMix) > 1e-9) {
      volMixLines.push({
        label,
        group: "Por produto",
        value: volMix / K,
        sortOrder: 100 + sortOrder,
      });
    }
  }
  const volMixDetail: DetailLine[] = [
    { label: "Volume", group: "Resumo", value: volume / K, sortOrder: 0 },
    { label: "Mix", group: "Resumo", value: mixTotal / K, sortOrder: 1 },
    ...volMixLines,
  ];

  // ---------- câmbio (linhas 149-153) ----------
  const domRevT = target.sales
    .filter((s) => s.domestic)
    .reduce((s, r) => s + r.amountKusd, 0);
  const revT = target.sales.reduce((s, r) => s + r.amountKusd, 0);
  const fxFactor = fxB !== 0 ? 1 - fxT / fxB : 0;
  const fxRevenue = domRevT * fxFactor; // J150
  const ebitdaCostT = target.params.ebitdaKusd - revT; // G151 (negativo)
  const fxCost = ebitdaCostT * target.params.dmCostShare * fxFactor; // J151
  const forex = fxRevenue + fxCost;
  const forexDetail: DetailLine[] = [
    { label: "Receita mercado doméstico", group: null, value: fxRevenue / K, sortOrder: 0 },
    { label: "Custos (parcela doméstica)", group: null, value: fxCost / K, sortOrder: 1 },
  ];

  // ---------- custo fixo (linhas 116-124) ----------
  const fixedByCat = new Map<
    string,
    { b?: FixedCostFact; t?: FixedCostFact; sortOrder: number }
  >();
  for (const f of source.fixed) fixedByCat.set(f.category, { b: f, sortOrder: f.sortOrder });
  for (const f of target.fixed) {
    const e = fixedByCat.get(f.category);
    if (e) e.t = f;
    else fixedByCat.set(f.category, { t: f, sortOrder: f.sortOrder });
  }
  let fixedCost = 0;
  const fixedDetail: DetailLine[] = [];
  for (const [category, { b, t, sortOrder }] of fixedByCat) {
    const amtB = b?.amountKusd ?? 0;
    const amtT = t?.amountKusd ?? 0;
    const usd = (t ?? b)?.usdDenominated ?? false;
    const fcForex = usd || fcFxB === 0 ? 0 : amtT * (fcFxT / fcFxB - 1); // col. I
    const eff = amtB - amtT - fcForex; // col. J
    fixedCost += eff;
    if (Math.abs(eff) > 1e-9) {
      fixedDetail.push({ label: category, group: null, value: eff / K, sortOrder });
    }
  }

  // ---------- preço de insumos (linhas 128-145) ----------
  const inputByItem = new Map<
    string,
    { b?: InputPriceFact; t?: InputPriceFact; sortOrder: number }
  >();
  for (const f of source.inputs) inputByItem.set(f.item, { b: f, sortOrder: f.sortOrder });
  for (const f of target.inputs) {
    const e = inputByItem.get(f.item);
    if (e) e.t = f;
    else inputByItem.set(f.item, { t: f, sortOrder: f.sortOrder });
  }
  let inputPrice = 0;
  const inputDetail: DetailLine[] = [];
  const prodT = target.params.crudeSteelKt / 1000; // G144
  for (const [item, { b, t, sortOrder }] of inputByItem) {
    let eff = 0;
    if (b?.unitPriceUsd != null || t?.unitPriceUsd != null) {
      const pB = b?.unitPriceUsd ?? 0;
      const pT = t?.unitPriceUsd ?? 0;
      const yieldF = t?.yieldFactor ?? b?.yieldFactor ?? 0;
      eff = (pB - pT) * yieldF * prodT; // col. J (128-134)
    } else {
      eff = (t?.amountKusd ?? 0) - (b?.amountKusd ?? 0); // itens diretos
    }
    inputPrice += eff;
    if (Math.abs(eff) > 1e-9) {
      inputDetail.push({ label: item, group: null, value: eff / K, sortOrder });
    }
  }

  // ---------- consumo / others / estoque (147, 155-181) ----------
  function diffMisc(driver: string): { total: number; lines: DetailLine[] } {
    const byLabel = new Map<
      string,
      { b?: MiscFact; t?: MiscFact; sortOrder: number }
    >();
    for (const m of source.misc.filter((m) => m.driver === driver)) {
      byLabel.set(m.label, { b: m, sortOrder: m.sortOrder });
    }
    for (const m of target.misc.filter((m) => m.driver === driver)) {
      const e = byLabel.get(m.label);
      if (e) e.t = m;
      else byLabel.set(m.label, { t: m, sortOrder: m.sortOrder });
    }
    let total = 0;
    const lines: DetailLine[] = [];
    for (const [label, { b, t, sortOrder }] of byLabel) {
      const eff = (t?.amountKusd ?? 0) - (b?.amountKusd ?? 0);
      total += eff;
      if (Math.abs(eff) > 1e-9) {
        lines.push({ label, group: null, value: eff / K, sortOrder });
      }
    }
    lines.sort((a, b) => a.sortOrder - b.sortOrder);
    return { total, lines };
  }
  const usage = diffMisc("usage");
  const others = diffMisc("others");
  const stock = diffMisc("stock_variation");

  // ---------- fechamento: variação de estoque como plug (linha 12) ----------
  const start = source.params.ebitdaKusd;
  const end = target.params.ebitdaKusd;
  const beforePlug =
    volMixTotal +
    sellingPrice +
    inputPrice +
    usage.total +
    fixedCost +
    forex +
    others.total;
  const stockPlug = end - start - beforePlug; // garante fechamento exato
  const svOthers = others.total + stockPlug;
  const svDetail: DetailLine[] = [
    ...others.lines.map((l) => ({ ...l, group: "Outros" })),
    ...stock.lines.map((l, i) => ({
      ...l,
      group: "Variação de estoque",
      sortOrder: 100 + i,
    })),
    {
      label: "Variação de estoque — ajuste de fechamento",
      group: "Variação de estoque",
      value: (stockPlug - stock.total) / K,
      sortOrder: 999,
    },
  ].filter((l) => Math.abs(l.value) > 1e-9);

  priceLines.sort((a, b) => b.value - a.value);
  volMixLines.sort((a, b) => b.value - a.value);

  return {
    start: start / K,
    end: end / K,
    drivers: {
      vol_mix: volMixTotal / K,
      selling_price: sellingPrice / K,
      input_price: inputPrice / K,
      usage: usage.total / K,
      fixed_cost: fixedCost / K,
      forex: forex / K,
      sv_others: svOthers / K,
    },
    details: {
      vol_mix: volMixDetail,
      selling_price: priceLines,
      input_price: inputDetail,
      usage: usage.lines,
      fixed_cost: fixedDetail,
      forex: forexDetail,
      sv_others: svDetail,
    },
  };
}
