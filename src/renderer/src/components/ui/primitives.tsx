/**
 * Primitivos de interface.
 *
 * Todos têm estados completos de hover, foco visível, ativo, desabilitado e
 * carregando. Controles desabilitados sempre explicam o motivo por `title`
 * e `aria-describedby` quando aplicável.
 */

import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import clsx from 'clsx';

/* ------------------------------------------------------------------ *
 * Botões
 * ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'text-[var(--text-inverse)]',
  secondary: 'text-[var(--text)]',
  ghost: 'text-[var(--text-muted)]',
  subtle: 'text-[var(--text)]',
  danger: 'text-[var(--text-inverse)]',
};

const VARIANT_STYLE: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: 'var(--accent)', borderColor: 'var(--accent)' },
  secondary: { background: 'var(--surface-2)', borderColor: 'var(--border-strong)' },
  ghost: { background: 'transparent', borderColor: 'transparent' },
  subtle: { background: 'var(--surface-2)', borderColor: 'var(--border)' },
  danger: { background: 'var(--danger)', borderColor: 'var(--danger)' },
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5',
  md: 'h-9 px-3.5 text-[13.5px] gap-2',
  lg: 'h-11 px-5 text-[14.5px] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  /** Motivo da indisponibilidade — exibido como dica e lido por leitores. */
  disabledReason?: string;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    iconLeft,
    iconRight,
    disabledReason,
    block,
    className,
    children,
    disabled,
    style,
    ...props
  },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={props.type ?? 'button'}
      disabled={isDisabled}
      title={isDisabled && disabledReason ? disabledReason : props.title}
      aria-disabled={isDisabled || undefined}
      className={clsx(
        'inline-flex select-none items-center justify-center rounded-[var(--radius-sm)] border font-medium',
        'transition-[background-color,border-color,color,opacity] duration-150',
        'hover:brightness-110 active:brightness-95',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        variant === 'ghost' && 'hover:bg-[var(--surface-3)] hover:text-[var(--text)]',
        block && 'w-full',
        className,
      )}
      style={{ ...VARIANT_STYLE[variant], ...style }}
      {...props}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : iconLeft}
      {children ? <span className="truncate">{children}</span> : null}
      {iconRight}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Rótulo acessível obrigatório. */
  label: string;
  size?: 'sm' | 'md';
  active?: boolean;
  tone?: 'default' | 'danger';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', active, tone = 'default', className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={props.title ?? label}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center justify-center rounded-[var(--radius-sm)] border border-transparent',
        'text-[var(--text-muted)] transition-colors duration-150',
        'hover:bg-[var(--surface-3)] hover:text-[var(--text)]',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        size === 'sm' ? 'h-6 w-6' : 'h-8 w-8',
        active && 'bg-[var(--accent-soft)] text-[var(--accent)]',
        tone === 'danger' && 'hover:text-[var(--danger)]',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------ *
 * Campos
 * ------------------------------------------------------------------ */

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
  inline?: boolean;
}

export function Field({ label, hint, error, htmlFor, children, inline }: FieldProps) {
  return (
    <div className={clsx('flex gap-2', inline ? 'items-center justify-between' : 'flex-col')}>
      <label
        htmlFor={htmlFor}
        className="text-[12.5px] font-medium text-[var(--text-muted)]"
      >
        {label}
      </label>
      <div className={clsx('flex flex-col gap-1', inline ? 'items-end' : 'w-full')}>
        {children}
        {hint && !error ? <p className="text-[12px] leading-snug text-[var(--text-faint)]">{hint}</p> : null}
        {error ? (
          <p className="text-[12px] leading-snug text-[var(--danger)]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const CONTROL_CLASS =
  'w-full rounded-[var(--radius-sm)] border bg-[var(--surface-inset)] px-2.5 text-[13.5px] text-[var(--text)] ' +
  'placeholder:text-[var(--text-faint)] transition-colors duration-150 ' +
  'hover:border-[var(--border-strong)] focus:border-[var(--border-focus)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={clsx(CONTROL_CLASS, 'h-9', className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={clsx(CONTROL_CLASS, 'py-2 leading-relaxed', className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select ref={ref} className={clsx(CONTROL_CLASS, 'h-9 pr-8', className)} {...props}>
      {children}
    </select>
  );
});

export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function Switch({ checked, onChange, label, hint, disabled, disabledReason }: SwitchProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] font-medium text-[var(--text)]">
          {label}
        </label>
        {hint ? (
          <p id={hintId} className="mt-0.5 text-[12px] leading-snug text-[var(--text-faint)]">
            {hint}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 h-5 w-9 flex-none rounded-full border transition-colors duration-150',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        style={{
          background: checked ? 'var(--accent)' : 'var(--surface-3)',
          borderColor: checked ? 'var(--accent)' : 'var(--border-strong)',
        }}
      >
        <span
          className="absolute top-[2px] h-3.5 w-3.5 rounded-full bg-white transition-[left] duration-150"
          style={{ left: checked ? '18px' : '2px' }}
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Indicadores
 * ------------------------------------------------------------------ */

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      role="status"
      aria-label="Carregando"
      className={clsx('ch-spin inline-block rounded-full border-2 border-current', className)}
      style={{
        width: size,
        height: size,
        borderTopColor: 'transparent',
        borderRightColor: 'transparent',
      }}
    />
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_STYLE: Record<BadgeTone, React.CSSProperties> = {
  neutral: { background: 'var(--surface-3)', color: 'var(--text-muted)', borderColor: 'var(--border)' },
  accent: { background: 'var(--accent-soft)', color: 'var(--accent)', borderColor: 'var(--accent)' },
  success: { background: 'var(--success-soft)', color: 'var(--success)', borderColor: 'var(--success)' },
  warning: { background: 'var(--warning-soft)', color: 'var(--warning)', borderColor: 'var(--warning)' },
  danger: { background: 'var(--danger-soft)', color: 'var(--danger)', borderColor: 'var(--danger)' },
  info: { background: 'var(--info-soft)', color: 'var(--info)', borderColor: 'var(--info)' },
};

export function Badge({
  children,
  tone = 'neutral',
  title,
  className,
  mono,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex max-w-full items-center gap-1 truncate rounded-[var(--radius-xs)] border px-1.5 py-[1px]',
        'text-[11.5px] font-medium leading-[16px]',
        mono && 'ch-mono',
        className,
      )}
      style={{ ...BADGE_STYLE[tone], borderStyle: 'solid', borderWidth: 1, opacity: 0.95 }}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      className="ch-mono rounded-[var(--radius-xs)] border px-1 py-[1px] text-[11px]"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--border-strong)', color: 'var(--text-muted)' }}
    >
      {children}
    </kbd>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="ch-anim-fade flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      {icon ? <div className="text-[var(--text-faint)]">{icon}</div> : null}
      <div className="max-w-[46ch]">
        <h3 className="text-[14px] font-semibold text-[var(--text)]">{title}</h3>
        {body ? <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{body}</p> : null}
      </div>
      {action}
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange(value: T): void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex rounded-[var(--radius-sm)] border p-[2px]"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--border)' }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.disabled ? option.disabledReason : option.hint}
            onClick={() => onChange(option.value)}
            className={clsx(
              'rounded-[var(--radius-xs)] font-medium transition-colors duration-150',
              size === 'sm' ? 'h-6 px-2 text-[12px]' : 'h-7 px-3 text-[12.5px]',
              selected ? 'text-[var(--text)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
            style={selected ? { background: 'var(--surface-0)', boxShadow: 'var(--shadow-panel)' } : undefined}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-faint)]">{children}</h4>
      {action}
    </div>
  );
}

export function Meter({
  value,
  max,
  label,
  tone = 'accent',
}: {
  value: number;
  max: number;
  label: string;
  tone?: BadgeTone;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="w-full">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-[var(--text-muted)]">{label}</span>
        <span className="ch-mono text-[11.5px] text-[var(--text-faint)]">{pct.toFixed(0)}%</span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--surface-3)' }}
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full transition-[width] duration-200"
          style={{ width: `${pct}%`, background: BADGE_STYLE[tone].color as string }}
        />
      </div>
    </div>
  );
}
