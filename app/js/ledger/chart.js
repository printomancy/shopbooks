// Default chart of accounts (categories). Each one maps to the line it lands on
// for a partnership (Form 1065 / 1125-A) and a single-member LLC or sole prop
// (Schedule C), so the same books work if the business changes form.
// Users can hide, rename or add categories; codes stay stable.

// group: income | cogs | expense | asset | liability | equity | transfer
export const DEFAULT_CATEGORIES = [
  // Income: sales are recorded before tax; the tax goes to Sales tax payable.
  { code: '4000', name: 'Sales: in person (cash)', group: 'income', f1065: '1a', schC: '1' },
  { code: '4010', name: 'Sales: in person (card)', group: 'income', f1065: '1a', schC: '1' },
  { code: '4020', name: 'Sales: own website', group: 'income', f1065: '1a', schC: '1' },
  { code: '4030', name: 'Sales: invoices and direct', group: 'income', f1065: '1a', schC: '1' },
  { code: '4040', name: 'Sales: Etsy', group: 'income', f1065: '1a', schC: '1' },
  { code: '4050', name: 'Sales: Whatnot', group: 'income', f1065: '1a', schC: '1' },
  { code: '4060', name: 'Sales: other marketplaces', group: 'income', f1065: '1a', schC: '1' },
  { code: '4100', name: 'Repair and service income', group: 'income', f1065: '1a', schC: '1' },
  { code: '4900', name: 'Refunds and returns', group: 'income', f1065: '1b', schC: '2' },
  { code: '4950', name: 'Interest and dividends', group: 'income', f1065: 'K-5', schC: '6' },
  { code: '4990', name: 'Other income', group: 'income', f1065: '7', schC: '6' },

  // Cost of goods sold
  { code: '5000', name: 'Filament and resin', group: 'cogs', f1065: '2', schC: '4' },
  { code: '5010', name: 'Parts and blanks for resale', group: 'cogs', f1065: '2', schC: '4' },
  { code: '5020', name: 'Packaging', group: 'cogs', f1065: '2', schC: '4' },
  { code: '5030', name: 'Shipping and postage', group: 'cogs', f1065: '2', schC: '4' },

  // Operating expenses
  { code: '6000', name: 'Printer parts and maintenance', group: 'expense', f1065: '11', schC: '21' },
  { code: '6010', name: 'Tools (under $2,500 each)', group: 'expense', f1065: '20', schC: '22' },
  { code: '6020', name: 'Booth and event fees', group: 'expense', f1065: '20', schC: '27a' },
  { code: '6030', name: 'Marketplace and platform fees', group: 'expense', f1065: '20', schC: '10' },
  { code: '6040', name: 'Payment processing fees', group: 'expense', f1065: '20', schC: '10' },
  { code: '6050', name: 'Software and subscriptions', group: 'expense', f1065: '20', schC: '18' },
  { code: '6055', name: 'Design files and licenses', group: 'expense', f1065: '20', schC: '27a' },
  { code: '6060', name: 'Advertising', group: 'expense', f1065: '20', schC: '8' },
  { code: '6070', name: 'Fuel (personal vehicle)', group: 'expense', f1065: '20', schC: '9', note: 'Counted against mileage; not deducted on top of it.' },
  { code: '6075', name: 'Mileage reimbursement', group: 'expense', f1065: '20', schC: '9' },
  { code: '6080', name: 'Meals (business)', group: 'expense', f1065: '20', schC: '24b' },
  { code: '6090', name: 'Office supplies', group: 'expense', f1065: '20', schC: '18' },
  { code: '6100', name: 'Utilities and phone', group: 'expense', f1065: '20', schC: '25' },
  { code: '6110', name: 'Rent', group: 'expense', f1065: '13', schC: '20b' },
  { code: '6120', name: 'Insurance', group: 'expense', f1065: '20', schC: '15' },
  { code: '6130', name: 'Licenses, permits and registrations', group: 'expense', f1065: '14', schC: '23' },
  { code: '6140', name: 'Bank fees', group: 'expense', f1065: '20', schC: '27a' },
  { code: '6150', name: 'Interest expense', group: 'expense', f1065: '15', schC: '16b' },
  { code: '6160', name: 'Professional fees', group: 'expense', f1065: '20', schC: '17' },
  { code: '6170', name: 'Contract labor', group: 'expense', f1065: '20', schC: '11' },
  { code: '6180', name: 'Education and training', group: 'expense', f1065: '20', schC: '27a' },
  { code: '6900', name: 'Other expense', group: 'expense', f1065: '20', schC: '27a' },

  // Balance sheet
  { code: '1500', name: 'Equipment (over $2,500 each)', group: 'asset', f1065: 'L', schC: '13', note: 'Depreciated or expensed under section 179.' },
  { code: '2100', name: 'Sales tax payable', group: 'liability', f1065: 'L', schC: '' },
  { code: '3000', name: 'Member contribution', group: 'equity', f1065: 'M-2', schC: '', member: true },
  { code: '3100', name: 'Member draw', group: 'equity', f1065: 'M-2', schC: '', member: true },

  // Money moving between your own accounts (never income or expense)
  { code: '9000', name: 'Transfer between my accounts', group: 'transfer' },
  { code: '9010', name: 'Card or line-of-credit payment', group: 'transfer' },
  { code: '9020', name: 'Cash float out / back', group: 'transfer' },
  { code: '9030', name: 'Platform payout', group: 'transfer' },
];

export const GROUP_LABELS = {
  income: 'Income',
  cogs: 'Cost of goods sold',
  expense: 'Expenses',
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Owners',
  transfer: 'Transfers',
};

// Account kinds. Amounts are always from the business's point of view:
// positive = money in (or a card balance paid down), negative = money out (or a charge).
export const ACCOUNT_KINDS = {
  bank: 'Bank account',
  credit_card: 'Credit card',
  line_of_credit: 'Line of credit',
  platform: 'Sales platform balance',
  cash: 'Cash',
  personal_card: 'Personal card (business charges only)',
};
