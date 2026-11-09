/**
 * Conta Service
 * Typed API client for the Accounting grimoire
 */

// With VITE_API_URL (panel and API on different origins) a relative path went to the
// panel server and returned its index.html with a 404.
const API_BASE = `${import.meta.env.VITE_API_URL ?? ""}/api/conta`;

// ============== Types ==============

export interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimalPlaces: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parentId?: string;
  isActive: boolean;
  isTrustAccount: boolean;
  currencyCode: string;
  description?: string;
  openingBalance: number;
  currentBalance: number;
  createdAt: string;
  updatedAt: string;
}

export interface Counterparty {
  id: string;
  name: string;
  type: "client" | "supplier" | "bank" | "government" | "other";
  taxId?: string;
  email?: string;
  phone?: string;
  address?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Matter {
  id: string;
  matterNumber: string;
  name: string;
  description?: string;
  clientId?: string;
  status: "open" | "closed" | "on_hold";
  openDate: string;
  closeDate?: string;
  responsibleId?: string;
  currencyCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface JournalTemplate {
  id: string;
  name: string;
  templateType: string;
  description?: string;
  isActive: boolean;
  lines: Array<{
    accountId: string;
    description?: string;
    debitAmount?: number;
    creditAmount?: number;
    percentage?: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface Journal {
  id: string;
  journalNumber: string;
  description: string;
  reference?: string;
  date: string;
  journalType: "manual" | "recurring" | "reversal" | "closing" | "adjustment";
  status: "draft" | "posted" | "reversed";
  currencyCode: string;
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
  postedAt?: string;
  reversedAt?: string;
  matterId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: string;
  journalId: string;
  accountId: string;
  description?: string;
  debitAmount: number;
  creditAmount: number;
  currencyCode: string;
  exchangeRate: number;
  matterId?: string;
  counterpartyId?: string;
  createdAt: string;
}

export interface Disbursement {
  id: string;
  description: string;
  amount: number;
  currencyCode: string;
  status: "pending" | "billed" | "paid" | "written_off";
  matterId?: string;
  date: string;
  billedAt?: string;
  paidAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrialBalanceReport {
  accounts: Array<{
    accountId: string;
    accountCode: string;
    accountName: string;
    debitTotal: number;
    creditTotal: number;
    balance: number;
  }>;
  totalDebit: number;
  totalCredit: number;
}

export interface BalanceSheetReport {
  assets: Array<{ accountId: string; name: string; amount: number }>;
  liabilities: Array<{ accountId: string; name: string; amount: number }>;
  equity: Array<{ accountId: string; name: string; amount: number }>;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
}

export interface ProfitLossReport {
  revenue: Array<{ accountId: string; name: string; amount: number }>;
  expenses: Array<{ accountId: string; name: string; amount: number }>;
  totalRevenue: number;
  totalExpenses: number;
  netIncome: number;
}

// ============== Currencies ==============

export async function getCurrencies(): Promise<Currency[]> {
  const res = await fetch(`${API_BASE}/currencies`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createCurrency(data: Partial<Currency>): Promise<Currency> {
  const res = await fetch(`${API_BASE}/currencies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Accounts ==============

export async function getAccounts(): Promise<Account[]> {
  const res = await fetch(`${API_BASE}/accounts`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getAccount(id: string): Promise<Account> {
  const res = await fetch(`${API_BASE}/accounts/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createAccount(data: Partial<Account>): Promise<Account> {
  const res = await fetch(`${API_BASE}/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateAccount(id: string, data: Partial<Account>): Promise<Account> {
  const res = await fetch(`${API_BASE}/accounts/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteAccount(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/accounts/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Counterparties ==============

export async function getCounterparties(): Promise<Counterparty[]> {
  const res = await fetch(`${API_BASE}/counterparties`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getCounterparty(id: string): Promise<Counterparty> {
  const res = await fetch(`${API_BASE}/counterparties/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createCounterparty(data: Partial<Counterparty>): Promise<Counterparty> {
  const res = await fetch(`${API_BASE}/counterparties`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateCounterparty(
  id: string,
  data: Partial<Counterparty>
): Promise<Counterparty> {
  const res = await fetch(`${API_BASE}/counterparties/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteCounterparty(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/counterparties/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Matters ==============

export async function getMatters(): Promise<Matter[]> {
  const res = await fetch(`${API_BASE}/matters`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getMatter(id: string): Promise<Matter> {
  const res = await fetch(`${API_BASE}/matters/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createMatter(data: Partial<Matter>): Promise<Matter> {
  const res = await fetch(`${API_BASE}/matters`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateMatter(id: string, data: Partial<Matter>): Promise<Matter> {
  const res = await fetch(`${API_BASE}/matters/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteMatter(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/matters/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Templates ==============

export async function getJournalTemplates(): Promise<JournalTemplate[]> {
  const res = await fetch(`${API_BASE}/templates`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getJournalTemplate(id: string): Promise<JournalTemplate> {
  const res = await fetch(`${API_BASE}/templates/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createJournalTemplate(
  data: Partial<JournalTemplate>
): Promise<JournalTemplate> {
  const res = await fetch(`${API_BASE}/templates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateJournalTemplate(
  id: string,
  data: Partial<JournalTemplate>
): Promise<JournalTemplate> {
  const res = await fetch(`${API_BASE}/templates/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteJournalTemplate(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/templates/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function applyJournalTemplate(
  id: string,
  data?: Record<string, unknown>
): Promise<Journal> {
  const res = await fetch(`${API_BASE}/templates/${id}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data || {}),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Journals ==============

export async function getJournals(): Promise<Journal[]> {
  const res = await fetch(`${API_BASE}/journals`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getJournal(id: string): Promise<Journal> {
  const res = await fetch(`${API_BASE}/journals/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createJournal(data: Partial<Journal>): Promise<Journal> {
  const res = await fetch(`${API_BASE}/journals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function updateJournal(id: string, data: Partial<Journal>): Promise<Journal> {
  const res = await fetch(`${API_BASE}/journals/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteJournal(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/journals/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function postJournal(id: string): Promise<Journal> {
  const res = await fetch(`${API_BASE}/journals/${id}/post`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function reverseJournal(id: string): Promise<Journal> {
  const res = await fetch(`${API_BASE}/journals/${id}/reverse`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== Disbursements ==============

export async function getDisbursements(): Promise<Disbursement[]> {
  const res = await fetch(`${API_BASE}/disbursements`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getDisbursement(id: string): Promise<Disbursement> {
  const res = await fetch(`${API_BASE}/disbursements/${id}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function createDisbursement(data: Partial<Disbursement>): Promise<Disbursement> {
  const res = await fetch(`${API_BASE}/disbursements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function billDisbursement(id: string): Promise<Disbursement> {
  const res = await fetch(`${API_BASE}/disbursements/${id}/bill`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function payDisbursement(id: string): Promise<Disbursement> {
  const res = await fetch(`${API_BASE}/disbursements/${id}/pay`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function deleteDisbursement(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/disbursements/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
}

// ============== Reports ==============

export async function getTrialBalance(): Promise<TrialBalanceReport> {
  const res = await fetch(`${API_BASE}/reports/trial-balance`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getBalanceSheet(): Promise<BalanceSheetReport> {
  const res = await fetch(`${API_BASE}/reports/balance-sheet`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getProfitLoss(): Promise<ProfitLossReport> {
  const res = await fetch(`${API_BASE}/reports/profit-loss`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ============== T-Account & Trust ==============

export async function getTAccount(accountId: string): Promise<LedgerEntry[]> {
  const res = await fetch(`${API_BASE}/t-account/${accountId}`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getTrustBalances(): Promise<Record<string, number>> {
  const res = await fetch(`${API_BASE}/trust-balances`, { credentials: "include" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
