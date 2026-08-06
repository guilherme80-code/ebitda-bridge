import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListBridgeExplanations,
  useCreateBridgeExplanation,
  useDeleteBridgeExplanation,
  getListBridgeExplanationsQueryKey,
} from '@workspace/api-client-react';
import { formatMUSD, cn } from '../lib/utils';
import { remainingToExplain } from '../lib/unexplained';
import { Textarea } from './ui/textarea';
import { MessageSquareText, Plus, Trash2, Loader2, CheckCircle2 } from 'lucide-react';

interface ExplanationsPanelProps {
  sourceId: string | null;
  targetId: string | null;
  enabled: boolean;
  /**
   * Residual a explicar (valor do passo de plug "Outros" — ou
   * "Estoque / Outros" quando não há Stock Variation nos dados —, isto é,
   * a variação total menos as alavancas nomeadas), em MUSD.
   */
  residual?: number;
}

export function ExplanationsPanel({ sourceId, targetId, enabled, residual }: ExplanationsPanelProps) {
  const queryClient = useQueryClient();
  const params = sourceId && targetId ? { source: sourceId, target: targetId } : undefined;
  const { data, isLoading } = useListBridgeExplanations(params, {
    query: { enabled: enabled && !!params, queryKey: getListBridgeExplanationsQueryKey(params) },
  });

  const [value, setValue] = useState('');
  const [text, setText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListBridgeExplanationsQueryKey(params) });

  const { mutate: create, isPending: saving } = useCreateBridgeExplanation({
    mutation: {
      onSuccess: () => {
        setValue('');
        setText('');
        setFormError(null);
        invalidate();
      },
      onError: () => setFormError('Could not save the explanation. Please try again.'),
    },
  });
  const { mutate: remove, isPending: removing } = useDeleteBridgeExplanation({
    mutation: { onSuccess: invalidate },
  });

  if (!enabled || !sourceId || !targetId) return null;

  const explanations = data?.explanations ?? [];
  const explainedTotal = explanations.reduce((acc, e) => acc + e.valueMusd, 0);

  const submit = () => {
    const num = Number(value.replace(',', '.'));
    if (!value.trim() || Number.isNaN(num)) {
      setFormError('Enter the difference value in MUSD (e.g. 12.5 or -3.2).');
      return;
    }
    if (!text.trim()) {
      setFormError('Describe the explanation for the difference.');
      return;
    }
    create({ data: { sourceId, targetId, valueMusd: num, text: text.trim() } });
  };

  return (
    <section
      className="bg-white border border-slate-200 shadow-sm border-t-4 border-t-brand-orange p-4 sm:p-6 animate-in fade-in slide-in-from-bottom-8 duration-700 fill-mode-both"
      data-testid="panel-explanations"
    >
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between mb-5">
        <div>
          <h2 className="text-xl font-bold text-slate-800 font-heading flex items-center gap-2">
            <MessageSquareText className="w-5 h-5 text-brand-orange" />
            Variance Explanations
          </h2>
          <p className="text-sm font-medium text-slate-500 mt-1">
            The bridge does not close from source data alone. Record the value and the explanation for the difference. Explanations are saved for anyone reviewing this scenario combination later.
          </p>
        </div>
        {typeof residual === 'number' && (
          <div
            className="mt-3 sm:mt-0 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm font-semibold text-slate-600 whitespace-nowrap"
            data-testid="text-variation-summary"
          >
            <span>
              Difference to explain:{' '}
              <span className={cn('font-mono font-bold', residual >= 0 ? 'text-emerald-600' : 'text-rose-600')}>
                {residual > 0 ? '+' : ''}{formatMUSD(residual)} MUSD
              </span>
            </span>
            <span className="text-slate-500" data-testid="text-explained-total">
              Explained:{' '}
              <span className="font-mono font-bold text-slate-700">
                {explainedTotal > 0 ? '+' : ''}{formatMUSD(explainedTotal)} MUSD
              </span>
            </span>
            {(() => {
              const remaining = remainingToExplain(residual, explainedTotal);
              return remaining === 0 ? (
                <span
                  className="inline-flex items-center gap-1.5 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5"
                  data-testid="text-remaining-to-explain"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Left to explain: <span className="font-mono font-bold">0.0 MUSD</span>
                </span>
              ) : (
                <span data-testid="text-remaining-to-explain">
                  Left to explain:{' '}
                  <span className={cn('font-mono font-bold', remaining > 0 ? 'text-emerald-600' : 'text-rose-600')}>
                    {remaining > 0 ? '+' : ''}{formatMUSD(remaining)} MUSD
                  </span>
                </span>
              );
            })()}
          </div>
        )}
      </div>

      {/* Lista de explicações salvas */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-slate-400 text-sm py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading explanations...
        </div>
      ) : explanations.length === 0 ? (
        <p className="text-sm text-slate-400 italic py-2" data-testid="text-no-explanations">
          No explanations recorded for this scenario combination.
        </p>
      ) : (
        <ul className="space-y-3 mb-6" data-testid="list-explanations">
          {explanations.map((e) => (
            <li
              key={e.id}
              className="flex items-start gap-4 bg-slate-50 border border-slate-200 p-3 sm:p-4"
              data-testid={`row-explanation-${e.id}`}
            >
              <span
                className={cn(
                  'font-mono font-bold text-sm px-2 py-1 border whitespace-nowrap',
                  e.valueMusd >= 0
                    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                    : 'text-rose-700 bg-rose-50 border-rose-200',
                )}
              >
                {e.valueMusd > 0 ? '+' : ''}{formatMUSD(e.valueMusd)} MUSD
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-700 font-medium whitespace-pre-wrap">{e.text}</p>
                <p className="text-[11px] text-slate-400 mt-1">
                  {new Date(e.createdAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
                </p>
              </div>
              <button
                onClick={() => remove({ id: e.id })}
                disabled={removing}
                title="Delete explanation"
                className="text-slate-300 hover:text-rose-500 transition-colors p-1"
                data-testid={`button-delete-explanation-${e.id}`}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Formulário de nova explicação */}
      <div className="border-t border-slate-100 pt-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="sm:w-44">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
              Value (MUSD)
            </label>
            <input
              type="text"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="e.g. 12.5"
              className="w-full border border-slate-200 px-3 py-2 text-sm font-mono focus:outline-none focus:border-brand-blue"
              data-testid="input-explanation-value"
            />
          </div>
          <div className="flex-1">
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
              Explanation for the difference
            </label>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Describe the cause of this part of the variance (e.g. price adjustment in the domestic market)"
              className="min-h-[64px]"
              data-testid="input-explanation-text"
            />
          </div>
          <div className="flex sm:items-end">
            <button
              onClick={submit}
              disabled={saving}
              className="inline-flex items-center gap-2 bg-brand-navy text-white font-bold text-sm px-5 py-2.5 hover:bg-brand-navy/90 disabled:opacity-50 transition-colors whitespace-nowrap"
              data-testid="button-add-explanation"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Add
            </button>
          </div>
        </div>
        {formError && (
          <p className="text-sm text-rose-600 font-medium mt-2" data-testid="text-explanation-error">
            {formError}
          </p>
        )}
      </div>
    </section>
  );
}
