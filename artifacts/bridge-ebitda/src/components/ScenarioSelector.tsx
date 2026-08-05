import { ArrowRight } from 'lucide-react';
import type { Scenario, ScenarioPair } from '@workspace/api-client-react';
import { cn } from '../lib/utils';

function ScenarioPicker({
  title,
  scenarios,
  selectedId,
  onSelect,
}: {
  title: string;
  scenarios: Scenario[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const selected = scenarios.find((s) => s.id === selectedId);
  const versions = [...new Set(scenarios.map((s) => s.version))];
  const periods = [...new Set(scenarios.map((s) => s.period))];

  const pick = (version: string, period: string, changed: 'version' | 'period') => {
    const exact = scenarios.find(
      (s) => s.version === version && s.period === period,
    );
    if (exact) {
      onSelect(exact.id);
      return;
    }
    // The exact combination doesn't exist — fall back to the first scenario
    // matching the field the user just changed.
    const fallback =
      changed === 'version'
        ? scenarios.find((s) => s.version === version)
        : scenarios.find((s) => s.period === period);
    if (fallback) onSelect(fallback.id);
  };

  return (
    <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
        {title}
      </p>
      <div className="flex items-center gap-3">
        <label className="flex-1">
          <span className="block text-[11px] font-semibold text-slate-500 mb-1">
            Versão
          </span>
          <select
            className="w-full text-sm font-bold text-slate-800 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400/40 cursor-pointer"
            value={selected?.version ?? ''}
            onChange={(e) => pick(e.target.value, selected?.period ?? periods[0], 'version')}
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1">
          <span className="block text-[11px] font-semibold text-slate-500 mb-1">
            Período
          </span>
          <select
            className="w-full text-sm font-bold text-slate-800 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400/40 cursor-pointer"
            value={selected?.period ?? ''}
            onChange={(e) => pick(selected?.version ?? versions[0], e.target.value, 'period')}
          >
            {periods.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

export function ScenarioSelector({
  scenarios,
  pairs,
  sourceId,
  targetId,
  onChange,
}: {
  scenarios: Scenario[];
  pairs: ScenarioPair[];
  sourceId: string | null;
  targetId: string | null;
  onChange: (sourceId: string, targetId: string) => void;
}) {
  const pairAvailable =
    !!sourceId &&
    !!targetId &&
    pairs.some((p) => p.sourceId === sourceId && p.targetId === targetId);

  return (
    <div className="w-full">
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <ScenarioPicker
          title="Origem"
          scenarios={scenarios}
          selectedId={sourceId}
          onSelect={(id) => onChange(id, targetId ?? id)}
        />
        <div className="hidden md:flex items-center justify-center w-10 h-10 rounded-full bg-slate-800 text-white shadow-sm shrink-0 self-center">
          <ArrowRight className="w-4 h-4" />
        </div>
        <ScenarioPicker
          title="Destino"
          scenarios={scenarios}
          selectedId={targetId}
          onSelect={(id) => onChange(sourceId ?? id, id)}
        />
      </div>
      <p
        className={cn(
          'text-xs font-semibold mt-2 transition-opacity',
          pairAvailable ? 'opacity-0 h-0 overflow-hidden' : 'text-amber-600',
        )}
      >
        Não há bridge disponível para esta combinação de cenários. Selecione outra combinação.
      </p>
    </div>
  );
}
