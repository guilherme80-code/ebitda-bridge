import { useState } from 'react';
import {
  useSimulateBridge,
  type SimulateBridgeResponse,
} from '@workspace/api-client-react';
import { Sparkles, Loader2, X } from 'lucide-react';

interface Props {
  source?: string;
  target?: string;
  enabled: boolean;
  simulation: SimulateBridgeResponse | null;
  onResult: (sim: SimulateBridgeResponse | null) => void;
}

export function ScenarioSimulator({ source, target, enabled, simulation, onResult }: Props) {
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { mutate, isPending } = useSimulateBridge({
    mutation: {
      onSuccess: (data) => {
        setError(null);
        onResult(data);
      },
      onError: (err: unknown) => {
        const data = (err as { data?: { error?: string } } | undefined)?.data;
        setError(
          data?.error ?? 'Não foi possível simular. Tente reformular o prompt.',
        );
      },
    },
  });

  const run = () => {
    if (!prompt.trim() || !enabled || isPending) return;
    mutate({ data: { prompt: prompt.trim() }, params: { source, target } });
  };

  return (
    <div className="bg-white border border-slate-200 shadow-sm p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-brand-blue" />
        <h2 className="font-bold text-slate-800 text-sm font-heading">Simular cenário</h2>
        <span className="text-[10px] font-bold uppercase tracking-widest text-white bg-brand-blue px-2 py-0.5">
          IA
        </span>
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && run()}
          placeholder='Ex.: "se a venda de Slab Calvert no MRF7 for maior em 10%"'
          data-testid="input-simulation-prompt"
          className="flex-1 border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-brand-blue"
          disabled={!enabled || isPending}
        />
        <button
          onClick={run}
          disabled={!enabled || isPending || !prompt.trim()}
          data-testid="button-simulate"
          className="inline-flex items-center justify-center gap-2 bg-brand-blue hover:bg-blue-700 disabled:opacity-40 text-white font-semibold text-sm px-5 py-2.5 transition-colors"
        >
          {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          {isPending ? 'Simulando…' : 'Simular'}
        </button>
      </div>

      {error && (
        <p className="text-sm font-medium text-rose-600" data-testid="text-simulation-error">
          {error}
        </p>
      )}

      {simulation && (
        <div
          className="bg-blue-50/70 border border-brand-blue/20 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
          data-testid="banner-simulation"
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-brand-navy">{simulation.interpretation}</p>
            <p className="text-xs font-medium text-brand-navy/80 mt-0.5">
              {simulation.adjustments.join(' • ')} — impacto no EBITDA final:{' '}
              <strong className={simulation.deltaEbitda >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                {simulation.deltaEbitda >= 0 ? '+' : ''}
                {simulation.deltaEbitda.toLocaleString('pt-BR', {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                })}{' '}
                MUSD
              </strong>
            </p>
          </div>
          <button
            onClick={() => onResult(null)}
            data-testid="button-clear-simulation"
            className="inline-flex items-center gap-1.5 self-start sm:self-auto bg-white border border-brand-blue/30 text-brand-blue hover:bg-blue-50 font-semibold text-xs px-3 py-1.5 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
            Limpar simulação
          </button>
        </div>
      )}
    </div>
  );
}
