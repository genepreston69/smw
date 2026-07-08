export type AppRole = "admin" | "estimator" | "approver" | "viewer";

export type PlanStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "changes_requested";

export type MaterialBasis = "per_lb" | "per_each" | "per_sf" | "lump_sum";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: AppRole;
}

export interface Customer {
  id: string;
  qb_id: string;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  active: boolean;
  last_synced_at: string | null;
}

export interface Job {
  id: string;
  qb_id: string;
  customer_id: string | null;
  name: string;
  fully_qualified_name: string | null;
  active: boolean;
  last_synced_at: string | null;
}

export interface ProjectPlan {
  id: string;
  customer_id: string | null;
  job_id: string | null;
  title: string;
  description: string | null;
  department: string | null;
  project_manager: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  start_date: string | null;
  end_date: string | null;
  payment_terms_days: number | null;
  notes: string | null;
  status: PlanStatus;
  version: number;
  labor_cost_rate: number;
  default_labor_bill_rate: number;
  consumables_pct: number;
  overhead_pool: number | null;
  created_by: string;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanPhase {
  id: string;
  plan_id: string;
  name: string;
  sort_order: number;
}

export interface PlanLineItem {
  id: string;
  plan_id: string;
  phase_id: string | null;
  sort_order: number;
  description: string;
  priority: 1 | 2 | 3;
  is_tbd: boolean;
  events: number;
  hours_per_piece: number;
  quantity: number;
  labor_bill_rate: number | null;
  material_basis: MaterialBasis;
  length_per_piece: number;
  weight_per_lf: number;
  unit_cost: number;
  lump_sum_cost: number;
  material_markup_pct: number;
}

export interface PlanTotals {
  plan_id: string;
  line_count: number;
  tbd_count: number;
  total_hours: number;
  material_cost: number;
  material_price: number;
  labor_cost: number;
  labor_price: number;
  consumables: number;
  overhead: number;
  total_cost: number;
  total_price: number;
  profit: number;
  profit_pct: number;
}

export interface Approval {
  id: string;
  plan_id: string;
  plan_version: number;
  approver_id: string;
  decision: "approved" | "rejected" | "changes_requested";
  comment: string | null;
  created_at: string;
}

export interface ApprovalThreshold {
  id: string;
  min_amount: number;
  max_amount: number | null;
  required_approvals: number;
  label: string;
}
