import { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatMUSD, cn } from '../lib/utils';
import type { BridgeStep } from '@workspace/api-client-react';

const CustomBar = (props: any) => {
  const { x, y, width, height, payload, index, data } = props;
  const isTotal = payload.isTotal;
  const isPositive = payload.value > 0;
  
  // Choose colors using exact HSL CSS vars
  const fill = isTotal 
    ? 'hsl(var(--total))' 
    : isPositive 
      ? 'hsl(var(--positive))' 
      : 'hsl(var(--negative))';
      
  const connectorY = isTotal ? y : (isPositive ? y : y + height);
  const isLast = index === data.length - 1;
  
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
        <rect x={x} y={y - 15} width={width} height={height + 30} fill="transparent" style={{ cursor: 'pointer' }} />
      )}
      {/* Minimum height of 2px so zero-value bars still show up */}
      <rect x={x} y={y} width={width} height={Math.max(height, 2)} fill={fill} rx={3} />
      <text
        x={x + width / 2}
        y={y - 10}
        fill={fill}
        textAnchor="middle"
        fontSize={13}
        fontWeight={700}
        fontFamily="var(--font-sans)"
      >
        {payload.value > 0 && !isTotal ? '+' : ''}{formatMUSD(payload.value)}
      </text>
    </g>
  );
};


const CustomTooltip = ({ active, payload }: any) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-white border border-slate-200 shadow-xl rounded-xl p-4 min-w-[220px]">
        <p className="font-bold text-slate-800 text-sm mb-3 pb-2 border-b border-slate-100">{data.label}</p>
        <div className="flex justify-between items-center text-sm mb-1.5">
          <span className="text-slate-500 font-medium">Impacto</span>
          <span className={cn(
            "font-bold font-mono",
            data.isTotal ? "text-slate-800" : data.value > 0 ? "text-emerald-600" : "text-rose-600"
          )}>
            {data.value > 0 && !data.isTotal ? '+' : ''}{formatMUSD(data.value)} MUSD
          </span>
        </div>
        {!data.isTotal && (
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

export function WaterfallChart({ steps, onBarClick }: { steps: BridgeStep[], onBarClick: (step: BridgeStep) => void }) {
  const chartData = useMemo(() => {
    if (!steps || steps.length === 0) return [];
    
    // Find min/max for Y axis
    const yVals = steps.flatMap(s =>
      s.kind === 'delta' ? [s.cumulative, s.cumulative - s.value] : [s.value],
    );
    const yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    const padding = (yMax - yMin) * 0.15;
    const chartMin = Math.max(0, Math.floor(yMin - padding));
    const chartMax = Math.ceil(yMax + padding);

    return steps.map(step => {
      const isTotal = step.kind === 'total_start' || step.kind === 'total_end';
      let start, end;
      if (isTotal) {
        start = chartMin;
        end = step.value;
      } else {
        start = step.cumulative - step.value;
        end = step.cumulative;
      }
      return {
        ...step,
        range: [Math.min(start, end), Math.max(start, end)],
        isTotal,
        chartMin,
        chartMax
      };
    });
  }, [steps]);

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
