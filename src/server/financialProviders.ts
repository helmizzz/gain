export interface DepositAddressRequest {
  customerRef: string;
  asset: string;
  network: string;
  idempotencyKey: string;
}

export interface DepositAddressAssignment {
  address: string;
  providerWalletId: string;
  asset: string;
  network: string;
  providerReference: string;
}

export interface CustodyBalanceSnapshot {
  businessDate: string;
  asset: string;
  network: string;
  available: string;
  pending: string;
  cold: string;
  sourceReference: string;
  asOf: string;
}

export interface PayoutRequest {
  withdrawalId: string;
  address: string;
  asset: string;
  network: string;
  amount: string;
  idempotencyKey: string;
}

export interface PayoutResult {
  providerPayoutId: string;
  txHash?: string;
  status: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
}

export interface CustodyAdapter {
  createDepositAddress(input: DepositAddressRequest): Promise<DepositAddressAssignment>;
  getBalanceSnapshot(date: string, asset: string, network: string): Promise<CustodyBalanceSnapshot>;
  submitPayout(input: PayoutRequest): Promise<PayoutResult>;
  verifyWebhook(rawBody: Uint8Array, headers: Record<string, string | undefined>): Promise<{ eventId: string; type: string; payload: unknown }>;
}

export interface ScreeningInput {
  subjectType: 'DEPOSIT_SOURCE' | 'WITHDRAWAL_DESTINATION' | 'CUSTOMER';
  subject: string;
  asset: string;
  network: string;
  transactionId: string;
}

export interface ScreeningResult {
  providerCaseId: string;
  result: 'CLEAR' | 'BLOCKED' | 'ERROR';
  reasonCode?: string;
}

export interface ScreeningAdapter {
  screen(input: ScreeningInput): Promise<ScreeningResult>;
}

export interface BankFundsSnapshot {
  businessDate: string;
  currency: string;
  customerFundsBalance: string;
  customerLiability: string;
  companyOperatingBalance: string;
  sourceReference: string;
  asOf: string;
}

// Production adapters must be implemented against the selected provider's
// official API contract, webhook signature scheme, idempotency behavior, and SLA.
