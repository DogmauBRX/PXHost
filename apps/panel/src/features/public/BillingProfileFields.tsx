import { z } from 'zod';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
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
}: {
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
}) {
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
            {...register('billingPostalCode' as never)}
          />
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
