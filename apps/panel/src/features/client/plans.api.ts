import { apiFetch } from '@/shared/api/client';
import type { ClientPlan } from '@/shared/api/types';

/** The public plan catalog — used by the upsell to find a "next plan up." */
export const listClientPlans = () => apiFetch<ClientPlan[]>('/api/client/plans');
