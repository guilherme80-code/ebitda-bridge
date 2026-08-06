import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatMUSD, cn } from '../lib/utils';
import { applyExplanations } from '../lib/unexplained';
import type { BridgeStep } from '@workspace/api-client-react';

const CHANGE_EPS = 0.05;

const CustomBar = (props: any) => {
  const { x, y, width, height, payload, index, data } = props;
  const isTotal = payload.isTotal;
  const isPositive = payload.value > 0;
  const compare = !!payload.compare;

  // Choose colors using exact HSL CSS vars
  const fill = isTotal
    ? 'hsl(var(--total))'
    : isPositive
      ? 'hsl(var(--positive))'
      : 'hsl(var(--negative))';

  const isLast = index === data.length - 1;

  // Escala px/unidade a partir do range plotado (união original+simulado).
  const [fullMin, fullMax] = payload.range as [number, number];
  const span = fullMax - fullMin;
  const ppu = span > 1e-9 ? height / span : 0;
  const toY = (v: number) => y + (fullMax - v) * ppu;

  // Retângulo simulado (ou único, sem comparação)
  const [sMin, sMax] = payload.simRange as [number, number];
  const simY = toY(sMax);
  const simH = Math.max((sMax - sMin) * ppu, 2);

  const connectorY = isTotal ? simY : (isPositive ? simY : simY + simH);
  const strokeColor = 'hsl(212 100% 48%)'; // brand-blue

  // Trecho hachurado "Explicado" (parte da diferença já justificada).
  const explainedRange = payload.explainedRange as [number, number] | undefined;
  const patternId = `explained-hatch-${index}`;
  const explainedRect = explainedRange
    ? {
        y: toY(explainedRange[1]),
        h: Math.max((explainedRange[1] - explainedRange[0]) * ppu, 2),
      }
    : undefined;
  const renderExplained = (rx: number, rw: number) =>
    explainedRect ? (
      <>
        <defs>
          <pattern id={patternId} width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={6} height={6} fill={fill} opacity={0.12} />
            <line x1={0} y1={0} x2={0} y2={6} stroke={fill} strokeWidth={2} opacity={0.45} />
          </pattern>
        </defs>
        <rect
          x={rx}
          y={explainedRect.y}
          width={rw}
          height={explainedRect.h}
          fill={`url(#${patternId})`}
          stroke={fill}
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.9}
        />
      </>
    ) : null;

  if (!compare) {
    return (
      <g className={cn("transition-opacity duration-300", payload.hasDetail ? "hover:opacity-80 cursor-pointer" : "")}>
        {!isLast && (
          <line
            x1={x + width}
            y1={connectorY}
            x2={x + width + (width * 0.55)}
            y2={connectorY}
            stroke="#94a3b8"
            strokeWidth={1.5}
            strokeDasharray="4 4"
          />
        )}
        {/* Interaction overlay to expand clickable area */}
        {payload.hasDetail && (
          <rect x={x} y={simY - 15} width={width} height={simH + 30} fill="transparent" style={{ cursor: 'pointer' }} />
        )}
        <rect x={x} y={simY} width={width} height={simH} fill={fill} rx={0} />
        {renderExplained(x, width)}
        <text
          x={x + width / 2}
          y={simY - 10}
          fill={fill}
          textAnchor="middle"
          fontSize={13}
          fontWeight={700}
          fontFamily="var(--font-heading)"
        >
          {payload.value > 0 && !isTotal ? '+' : ''}{formatMUSD(payload.value)}
        </text>
      </g>
    );
  }

  // Modo comparação: barra original (fantasma) à esquerda, simulada à direita.
  const [bMin, bMax] = payload.baseRange as [number, number];
  const baseY = toY(bMax);
  const baseH = Math.max((bMax - bMin) * ppu, 2);
  const gap = width * 0.06;
  const half = (width - gap) / 2;
  const changed = !!payload.changedStep;
  const topY = Math.min(simY, baseY);

  return (
    <g className="transition-opacity duration-300">
      {!isLast && (
        <line
          x1={x + width}
          y1={connectorY}
          x2={x + width + (width * 0.55)}
          y2={connectorY}
          stroke="#94a3b8"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
      )}
      {/* Original (fantasma) */}
      <rect x={x} y={baseY} width={half} height={baseH} fill="#94a3b8" opacity={0.45} rx={0} />
      {/* Simulado */}
      <rect
        x={x + half + gap}
        y={simY}
        width={half}
        height={simH}
        fill={fill}
        rx={0}
        stroke={changed ? strokeColor : 'none'}
        strokeWidth={changed ? 2.5 : 0}
      />
      {renderExplained(x + half + gap, half)}
      <text
        x={x + width / 2}
        y={topY - (changed ? 24 : 10)}
        fill={fill}
        textAnchor="middle"
        fontSize={13}
        fontWeight={700}
        fontFamily="var(--font-heading)"
      >
        {payload.value > 0 && !isTotal ? '+' : ''}{formatMUSD(payload.value)}
      </text>
      {changed && (
        <text
          x={x + width / 2}
          y={topY - 8}
          fill={strokeColor}
          textAnchor="middle"
          fontSize={11}
          fontWeight={700}
          fontFamily="var(--font-heading)"
        >
          Δ {payload.value - payload.baseValue > 0 ? '+' : ''}{formatMUSD(payload.value - payload.baseValue)}
        </text>
      )}
    </g>
  );
};


const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    if (data.compare) {
      const delta = data.value - data.baseValue;
      return (
        <div className="bg-white border border-slate-200 shadow-xl p-4 min-w-[240px]">
          <p className="font-bold text-slate-800 text-sm mb-3 pb-2 border-b border-slate-100 font-heading">
            {data.label}
            {data.changedStep && (
              <span className="ml-2 align-middle text-[9px] font-bold uppercase tracking-widest text-brand-blue bg-blue-50 px-1.5 py-0.5 border border-brand-blue/20">
                Ajustado
              </span>
            )}
          </p>
          <div className="flex justify-between items-center text-sm mb-1.5">
            <span className="text-slate-500 font-medium">Original</span>
            <span className="font-bold text-slate-500 font-mono">
              {data.baseValue > 0 && !data.isTotal ? '+' : ''}{formatMUSD(data.baseValue)} MUSD
            </span>
          </div>
          <div className="flex justify-between items-center text-sm mb-1.5">
            <span className="text-slate-500 font-medium">Simulado</span>
            <span className={cn(
              "font-bold font-mono",
              data.isTotal ? "text-slate-800" : data.value > 0 ? "text-emerald-600" : "text-rose-600"
            )}>
              {data.value > 0 && !data.isTotal ? '+' : ''}{formatMUSD(data.value)} MUSD
            </span>
          </div>
          {Math.abs(delta) > CHANGE_EPS && (
            <div className="flex justify-between items-center text-sm">
              <span className="text-slate-500 font-medium">Δ Simulação</span>
              <span className="font-bold text-brand-blue font-mono">
                {delta > 0 ? '+' : ''}{formatMUSD(delta)} MUSD
              </span>
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="bg-white border border-slate-200 shadow-xl p-4 min-w-[220px]">
        <p className="font-bold text-slate-800 text-sm mb-3 pb-2 border-b border-slate-100 font-heading">{data.label}</p>
        <div className="flex justify-between items-center text-sm mb-1.5">
          <span className="text-slate-500 font-medium">Impacto</span>
          <span className={cn(
            "font-bold font-mono",
            data.isTotal ? "text-slate-800" : data.value > 0 ? "text-emerald-600" : "text-rose-600"
          )}>
            {data.value > 0 && !data.isTotal ? '+' : ''}{formatMUSD(data.value)} MUSD
          </span>
        </div>
        {data.key === 'unexplained' && (
          <p className="text-[11px] text-slate-400 font-medium mb-1.5">
            Parte da variação ainda sem explicação registrada no painel abaixo.
          </p>
        )}
        {data.key === 'unexplained' && data.explainedMusd !== undefined && Math.abs(data.explainedMusd) > 1e-9 && (
          <div className="flex justify-between items-center text-sm mb-1.5">
            <span className="text-slate-500 font-medium">Explicado</span>
            <span className="font-bold text-slate-700 font-mono">
              {data.explainedMusd > 0 ? '+' : ''}{formatMUSD(data.explainedMusd)} MUSD
            </span>
          </div>
        )}
        {!data.isTotal && data.key !== 'unexplained' && (
          <div className="flex justify-between items-center text-sm">
            <span className="text-slate-500 font-medium">Acumulado</span>
            <span className="font-bold text-slate-800 font-mono">{formatMUSD(data.cumulative)} MUSD</span>
          </div>
        )}
        {data.hasDetail && (
          <div className="mt-4 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500 font-bold p-2 rounded text-center">
            Clique na barra para detalhes
          </div>
        )}
      </div>
    );
  }
  return null;
};

interface WaterfallChartProps {
  steps: BridgeStep[];
  /** Passos originais para comparação lado a lado (modo simulação). */
  baseSteps?: BridgeStep[];
  /**
   * Soma das explicações registradas para o par (MUSD). Cada série calcula
   * seu resíduo "Não Explicado" a partir dos próprios totais; quando o
   * resíduo é ~zero (ou o valor é undefined, ainda carregando), a coluna
   * não aparece.
   */
  explainedTotal?: number;
  onBarClick: (step: BridgeStep) => void;
}

export function WaterfallChart({ steps, baseSteps, explainedTotal, onBarClick }: WaterfallChartProps) {
  const chartData = useMemo(() => {
    if (!steps || steps.length === 0) return [];
    const compare = !!baseSteps && baseSteps.length > 0;

    // Coluna "Não Explicado": vem do servidor apenas quando o bridge não
    // fecha pela fonte. Aqui só descontamos as explicações registradas do
    // valor mostrado (a coluna some quando o resíduo é ~zero). Cada série
    // (original/simulada) usa a diferença dos seus próprios passos.
    const steps_ = applyExplanations(steps, explainedTotal);
    const baseSteps_ = baseSteps ? applyExplanations(baseSteps, explainedTotal) : baseSteps;
    const baseByKey = new Map((baseSteps_ ?? []).map((s) => [s.key, s]));

    const stepRange = (s: BridgeStep): [number, number] => {
      const isTotal = s.kind !== 'delta';
      const start = isTotal ? 0 : s.cumulative - s.value;
      const end = isTotal ? s.value : s.cumulative;
      return [Math.min(start, end), Math.max(start, end)];
    };

    // Find min/max for Y axis (inclui a série original quando em comparação)
    const allSteps = compare ? [...steps_, ...(baseSteps_ ?? [])] : steps_;
    const yVals = allSteps.flatMap(s =>
      s.kind === 'delta' ? [s.cumulative, s.cumulative - s.value] : [s.value],
    );
    const yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    const padding = (yMax - yMin) * 0.15;
    const chartMin = Math.max(0, Math.floor(yMin - padding));
    const chartMax = Math.ceil(yMax + padding);

    return steps_.map(step => {
      const isTotal = step.kind === 'total_start' || step.kind === 'total_end';
      let start, end;
      if (isTotal) {
        start = chartMin;
        end = step.value;
      } else {
        start = step.cumulative - step.value;
        end = step.cumulative;
      }
      const simRange: [number, number] = [Math.min(start, end), Math.max(start, end)];

      // Trecho já explicado da coluna "Não Explicado": do fim do resíduo até
      // onde a coluna original terminaria (resíduo + explicado).
      const explainedMusd = (step as { explainedMusd?: number }).explainedMusd;
      let explainedRange: [number, number] | undefined;
      if (explainedMusd !== undefined && Math.abs(explainedMusd) > 1e-9 && !isTotal) {
        const expStart = step.cumulative;
        const expEnd = step.cumulative + explainedMusd;
        explainedRange = [Math.min(expStart, expEnd), Math.max(expStart, expEnd)];
      }

      // Chave 'ebitda_target' equivale nas duas séries (rótulo difere).
      const base = baseByKey.get(step.key);
      let baseRange: [number, number] = simRange;
      let baseValue = step.value;
      if (compare && base) {
        baseValue = base.value;
        if (base.kind === 'delta') {
          const bStart = base.cumulative - base.value;
          baseRange = [Math.min(bStart, base.cumulative), Math.max(bStart, base.cumulative)];
        } else {
          baseRange = [chartMin, base.value];
        }
      }
      let range: [number, number] = compare
        ? [Math.min(simRange[0], baseRange[0]), Math.max(simRange[1], baseRange[1])]
        : simRange;
      if (explainedRange) {
        range = [Math.min(range[0], explainedRange[0]), Math.max(range[1], explainedRange[1])];
      }

      return {
        ...step,
        range,
        explainedRange,
        explainedMusd,
        simRange,
        baseRange,
        baseValue,
        compare,
        changedStep: compare && Math.abs(step.value - baseValue) > CHANGE_EPS,
        isTotal,
        chartMin,
        chartMax
      };
    });
  }, [steps, baseSteps, explainedTotal]);

  if (chartData.length === 0) return null;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart 
        data={chartData} 
        margin={{ top: 40, right: 20, left: 20, bottom: 60 }}
        barCategoryGap="25%"
      >
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
        <XAxis 
          dataKey="label" 
          axisLine={false} 
          tickLine={false} 
          tick={{ fill: '#64748b', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)' }}
          dy={15}
          interval={0}
          angle={-25}
          textAnchor="end"
        />
        <YAxis 
          domain={[chartData[0].chartMin, chartData[0].chartMax]}
          axisLine={false}
          tickLine={false}
          tick={{ fill: '#94a3b8', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)' }}
          tickFormatter={(val) => formatMUSD(val)}
          width={65}
        />
        <Tooltip 
          cursor={{fill: '#f8fafc', opacity: 0.8}} 
          content={<CustomTooltip />} 
          isAnimationActive={false}
        />
        
        <Bar 
          dataKey="range" 
          shape={(props: any) => <CustomBar {...props} data={chartData} />}
          onClick={(data) => {
            if (data && data.payload && onBarClick) {
              onBarClick(data.payload);
            }
          }}
          isAnimationActive={true}
          animationDuration={1000}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
