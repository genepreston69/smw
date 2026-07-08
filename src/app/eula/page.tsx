import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "End-User License Agreement — SMW Job Plans",
};

export default function EulaPage() {
  return (
    <LegalPage title="End-User License Agreement">
      <p>
        SMW Job Plans is proprietary internal software operated by Superior
        Marine. Use of this application is limited to Superior Marine
        employees and individuals explicitly authorized by Superior Marine
        management.
      </p>
      <p>
        <strong>License.</strong> Authorized users are granted a limited,
        non-transferable right to use the application for Superior
        Marine&apos;s business purposes only. No right to copy, modify,
        distribute, or resell the software is granted.
      </p>
      <p>
        <strong>Acceptable use.</strong> Users must keep their credentials
        confidential, enter accurate business information, and use the
        application only for preparing and approving job cost estimates and
        related business records.
      </p>
      <p>
        <strong>Data.</strong> All business data entered into the application
        is and remains the property of Superior Marine. Handling of personal
        information is described in the{" "}
        <a href="/privacy" className="text-brand-600 underline">
          Privacy Policy
        </a>
        .
      </p>
      <p>
        <strong>Disclaimer.</strong> The application is provided &ldquo;as
        is&rdquo; for internal business use. Superior Marine may modify,
        suspend, or discontinue the application at any time.
      </p>
      <p className="text-ink-400">Last updated: July 2026</p>
    </LegalPage>
  );
}
