import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = { title: "Privacy Policy — SMW Job Plans" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        SMW Job Plans is an internal business application operated by Superior
        Marine for its employees and authorized users. It is not offered to the
        general public.
      </p>
      <p>
        <strong>What we collect.</strong> The application stores business data
        entered by authorized users (project plans, job cost estimates, and
        approval records) and account information for those users (name, email
        address, and role). When connected to QuickBooks Online, it imports
        customer and job records from the company&apos;s own QuickBooks
        account.
      </p>
      <p>
        <strong>How it is used.</strong> Data is used solely to prepare,
        review, and approve job cost estimates for Superior Marine&apos;s
        business operations. It is not sold, rented, or shared with third
        parties for marketing purposes.
      </p>
      <p>
        <strong>Storage and security.</strong> Data is stored with our hosting
        and database providers (Vercel and Supabase) in the United States,
        protected by encryption in transit, authenticated access, and
        role-based permissions. QuickBooks access tokens are stored server-side
        and are never exposed to end users.
      </p>
      <p>
        <strong>QuickBooks data.</strong> Access to QuickBooks Online is
        read-only for customer and job records, authorized through
        Intuit&apos;s OAuth service. The connection can be revoked at any time
        from QuickBooks or from the application&apos;s settings.
      </p>
      <p>
        <strong>Contact.</strong> Questions about this policy can be directed
        to Superior Marine management.
      </p>
      <p className="text-ink-400">Last updated: July 2026</p>
    </LegalPage>
  );
}
