import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { FieldErrors, UseFormRegister, UseFormSetValue } from 'react-hook-form';
import { CreditCard, Hash, Home, Landmark, MapPin } from 'lucide-react';
import { Field, Input, Select } from '@/ui/primitives';
import type { ClientAccount } from '@/shared/api/types';
import { isValidCpf } from './cpf';

// The 27 Brazilian UF codes — a static list, never fetched from the
// backend (it never changes). billingCountry is fixed at "BR" server-side
// (see ClientAccount's own comment), so there's no country select here.
const UF_CODES = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB',
  'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

// Required-together set — cpf + full address, mirroring
// SubscriptionsService.createForUser's own completeness check.
// billingAddressComplement is the one field that's always optional.
export const billingSchema = z.object({
  cpf: z.string().min(1, 'Informe seu CPF').refine((v) => isValidCpf(v), 'CPF inválido'),
  billingPostalCode: z
    .string()
    .min(1, 'Informe o CEP')
    .regex(/^\d{5}-?\d{3}$/, 'CEP inválido'),
  billingAddressLine: z.string().min(1, 'Informe o endereço'),
  billingAddressNumber: z.string().min(1, 'Informe o número'),
  billingAddressComplement: z.string().optional(),
  billingNeighborhood: z.string().min(1, 'Informe o bairro'),
  billingCity: z.string().min(1, 'Informe a cidade'),
  billingState: z.string().length(2, 'Selecione o estado'),
});
export type BillingFormValues = z.infer<typeof billingSchema>;

// True only when EVERY required field is present — mirrors
// SubscriptionsService.createForUser's own completeness check
// server-side, so the UI never shows "Confirmar assinatura" for a
// profile the backend would reject anyway. complement stays excluded
// (always optional).
export function isBillingProfileComplete(account: ClientAccount): boolean {
  return (
    !!account.cpf &&
    !!account.billingPostalCode &&
    !!account.billingAddressLine &&
    !!account.billingAddressNumber &&
    !!account.billingNeighborhood &&
    !!account.billingCity &&
    !!account.billingState
  );
}

export function accountToBillingForm(account: ClientAccount): BillingFormValues {
  return {
    cpf: account.cpf ?? '',
    billingPostalCode: account.billingPostalCode ?? '',
    billingAddressLine: account.billingAddressLine ?? '',
    billingAddressNumber: account.billingAddressNumber ?? '',
    billingAddressComplement: account.billingAddressComplement ?? '',
    billingNeighborhood: account.billingNeighborhood ?? '',
    billingCity: account.billingCity ?? '',
    billingState: account.billingState ?? '',
  };
}

/**
 * Shared by CheckoutPage.tsx (collected at subscribe time) and
 * SettingsPage.tsx (editable afterward) — one place for the fields, the
 * validation, and the layout, per the plan's "um único lugar" decision.
 */
export function BillingProfileFields<T extends BillingFormValues>({
  register,
  errors,
  setValue,
}: {
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  setValue: UseFormSetValue<T>;
}) {
  const [typedCep, setTypedCep] = useState('');
  const [cepStatus, setCepStatus] = useState<'idle' | 'loading' | 'found' | 'missing' | 'error'>('idle');
  const postalField = register('billingPostalCode' as never);

  useEffect(() => {
    const cep = typedCep.replace(/\D/g, '');
    if (cep.length !== 8) return;

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCepStatus('loading');
      try {
        const response = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: controller.signal });
        if (!response.ok) throw new Error('CEP lookup failed');
        const address = await response.json() as {
          erro?: boolean;
          logradouro?: string;
          bairro?: string;
          localidade?: string;
          uf?: string;
        };
        if (controller.signal.aborted) return;
        if (address.erro) {
          setCepStatus('missing');
          return;
        }
        // Some CEPs cover a whole city and have no street or neighborhood.
        // Fill what exists and leave every field editable for corrections.
        if (address.logradouro) setValue('billingAddressLine' as never, address.logradouro as never, { shouldValidate: true });
        if (address.bairro) setValue('billingNeighborhood' as never, address.bairro as never, { shouldValidate: true });
        if (address.localidade) setValue('billingCity' as never, address.localidade as never, { shouldValidate: true });
        if (address.uf) setValue('billingState' as never, address.uf as never, { shouldValidate: true });
        setCepStatus('found');
      } catch {
        if (!controller.signal.aborted) setCepStatus('error');
      }
    }, 400);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [typedCep, setValue]);

  return (
    <div className="space-y-4">
      <Field label="CPF" htmlFor="billing-cpf" error={errors.cpf?.message as string | undefined}>
        <Input id="billing-cpf" icon={CreditCard} placeholder="000.000.000-00" invalid={!!errors.cpf} {...register('cpf' as never)} />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_2fr]">
        <Field label="CEP" htmlFor="billing-postal-code" error={errors.billingPostalCode?.message as string | undefined}>
          <Input
            id="billing-postal-code"
            icon={Hash}
            placeholder="00000-000"
            invalid={!!errors.billingPostalCode}
            {...postalField}
            onChange={(event) => {
              void postalField.onChange(event);
              setTypedCep(event.target.value);
              setCepStatus('idle');
            }}
          />
          <p className="mt-1 text-xs text-text-muted" aria-live="polite">
            {cepStatus === 'loading' && 'Buscando endereço…'}
            {cepStatus === 'found' && 'Endereço preenchido. Confira os dados e informe o número.'}
            {cepStatus === 'missing' && 'CEP não encontrado. Confira o número ou preencha o endereço manualmente.'}
            {cepStatus === 'error' && 'Não foi possível consultar o CEP. Preencha o endereço manualmente.'}
          </p>
        </Field>
        <Field label="Endereço" htmlFor="billing-address-line" error={errors.billingAddressLine?.message as string | undefined}>
          <Input id="billing-address-line" icon={Home} invalid={!!errors.billingAddressLine} {...register('billingAddressLine' as never)} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Bairro" htmlFor="billing-neighborhood" error={errors.billingNeighborhood?.message as string | undefined}>
          <Input id="billing-neighborhood" icon={MapPin} invalid={!!errors.billingNeighborhood} {...register('billingNeighborhood' as never)} />
        </Field>
        <Field label="Número" htmlFor="billing-address-number" error={errors.billingAddressNumber?.message as string | undefined}>
          <Input id="billing-address-number" icon={Hash} invalid={!!errors.billingAddressNumber} {...register('billingAddressNumber' as never)} />
        </Field>
        <Field label="Complemento" htmlFor="billing-address-complement" hint="Opcional">
          <Input id="billing-address-complement" icon={Home} {...register('billingAddressComplement' as never)} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
        <Field label="Cidade" htmlFor="billing-city" error={errors.billingCity?.message as string | undefined}>
          <Input id="billing-city" icon={MapPin} invalid={!!errors.billingCity} {...register('billingCity' as never)} />
        </Field>
        <Field label="Estado" htmlFor="billing-state" error={errors.billingState?.message as string | undefined}>
          <Select id="billing-state" icon={Landmark} invalid={!!errors.billingState} defaultValue="" {...register('billingState' as never)}>
            <option value="" disabled>
              Selecione
            </option>
            {UF_CODES.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  );
}
