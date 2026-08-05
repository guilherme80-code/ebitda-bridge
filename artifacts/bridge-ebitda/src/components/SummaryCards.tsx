import { BridgeSummary } from '@workspace/api-client-react';
import { TrendingUp, TrendingDown, Activity, ArrowRight, PlusCircle, MinusCircle } from 'lucide-react';
import { formatMUSD, cn } from '../lib/utils';

export function SummaryCards({ summary }: { summary: BridgeSummary }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Variação Total */}
      <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-slate-50 rounded-bl-full -z-10 group-hover:scale-110 transition-transform duration-500" />
        <div className="flex justify-between items-start">
          <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Variação de EBITDA</p>
          <Activity className="w-4 h-4 text-slate-400" />
        </div>
        <div className="mt-2 flex items-baseline space-x-2">
          <p className={cn("text-3xl font-bold tracking-tight", summary.totalVariation >= 0 ? "text-emerald-600" : "text-rose-600")}>
            {formatMUSD(summary.totalVariation, true)}
          </p>
        </div>
        <div className="flex items-center text-[12px] font-medium text-slate-500 mt-4 bg-slate-50/80 rounded-lg p-2.5 justify-between border border-slate-100">
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">{summary.startLabel}</span>
            <span className="text-slate-800 font-semibold">{formatMUSD(summary.startValue)}</span>
          </div>
          <ArrowRight className="w-3 h-3 text-slate-300 mx-2" />
          <div className="flex flex-col text-right">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 mb-0.5">{summary.endLabel}</span>
            <span className="text-slate-800 font-semibold">{formatMUSD(summary.endValue)}</span>
          </div>
        </div>
      </div>

      {/* Maior Positivo */}
      <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-50/50 rounded-bl-full -z-10 group-hover:scale-110 transition-transform duration-500" />
        <div className="flex justify-between items-start">
          <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Principal Alavanca (+)</p>
          <TrendingUp className="w-4 h-4 text-emerald-500" />
        </div>
        <div className="mt-4">
          <p className="text-3xl font-bold tracking-tight text-emerald-600">{formatMUSD(summary.largestPositive.value, true)}</p>
          <p className="text-sm font-medium text-slate-700 mt-2 truncate border-t border-slate-100 pt-3" title={summary.largestPositive.label}>
            {summary.largestPositive.label}
          </p>
        </div>
      </div>

      {/* Maior Negativo */}
      <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-between relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-24 h-24 bg-rose-50/50 rounded-bl-full -z-10 group-hover:scale-110 transition-transform duration-500" />
        <div className="flex justify-between items-start">
          <p className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Principal Detrator (-)</p>
          <TrendingDown className="w-4 h-4 text-rose-500" />
        </div>
        <div className="mt-4">
          <p className="text-3xl font-bold tracking-tight text-rose-600">{formatMUSD(summary.largestNegative.value, true)}</p>
          <p className="text-sm font-medium text-slate-700 mt-2 truncate border-t border-slate-100 pt-3" title={summary.largestNegative.label}>
            {summary.largestNegative.label}
          </p>
        </div>
      </div>

      {/* Totalizadores de Efeitos */}
      <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm flex flex-col justify-center space-y-5 relative overflow-hidden">
        <div className="flex justify-between items-center bg-emerald-50/30 p-3 rounded-lg border border-emerald-50">
          <div className="flex items-center space-x-3">
            <div className="bg-emerald-100 p-1.5 rounded-md text-emerald-600">
              <PlusCircle className="w-4 h-4" />
            </div>
            <span className="text-sm font-semibold text-slate-700">Total Efeitos (+)</span>
          </div>
          <span className="font-bold text-emerald-600 text-lg">{formatMUSD(summary.positiveTotal, true)}</span>
        </div>
        <div className="flex justify-between items-center bg-rose-50/30 p-3 rounded-lg border border-rose-50">
          <div className="flex items-center space-x-3">
            <div className="bg-rose-100 p-1.5 rounded-md text-rose-600">
              <MinusCircle className="w-4 h-4" />
            </div>
            <span className="text-sm font-semibold text-slate-700">Total Efeitos (-)</span>
          </div>
          <span className="font-bold text-rose-600 text-lg">{formatMUSD(summary.negativeTotal, true)}</span>
        </div>
      </div>
    </div>
  );
}
