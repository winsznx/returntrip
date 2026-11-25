export const PAYMENT_CSV_COLUMNS = [
  'voucher_number',
  'amount',
  'check_date',
  'department_name',
  'contract_number',
  'vendor_name',
] as const;

export interface NewPayment {
  readonly voucherNumber: string | null;
  readonly amountCents: bigint;
  readonly checkDate: string;
  readonly departmentName: string | null;
  readonly contractNumber: string;
  readonly vendorName: string;
}

export interface Payment extends NewPayment {
  readonly id: number;
}
