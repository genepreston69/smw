import Link from "next/link";
import {
  ArrowLeft,
  Check,
  MessageSquareWarning,
  Send,
  X,
} from "lucide-react";
import { requireUser } from "@/lib/auth";
import { PrintButton } from "@/components/PrintButton";
import { buttonCls } from "@/components/ui";

export const metadata = {
  title: "Barge Program — Instruction Manual",
};

/* ---------------------------------------------------------------------------
   Printable instruction manual for the Barge Program. Static content — the
   authoritative behavior lives in the rough-quote model and cost mirror
   (lib/barge.ts), the workbench (BargeQuoteWorkbench.tsx), the builder
   (RoughQuoteBuilder.tsx), and the SQL views/workflow functions in
   supabase/migrations/0017_barge_program.sql. Keep this page in sync when
   those change. Figures use numbers computed by the real model: the default
   120' × 40' × 8' rough quote and the engineer reference takeoff.
--------------------------------------------------------------------------- */

const TOC = [
  ["overview", "1. What the Barge Program is"],
  ["roles", "2. Roles & permissions"],
  ["granularity", "3. Three levels of detail — which tool to use when"],
  ["landing", "4. A tour of the landing page"],
  ["rough", "5. The Rough Quote Builder"],
  ["config", "6. Configuration inputs, field by field"],
  ["saved", "7. Saved configurations"],
  ["assumptions", "8. The assumptions built into the model"],
  ["create", "9. Creating an editable quote"],
  ["workbench", "10. The quote workbench — a tour"],
  ["takeoff", "11. The steel takeoff, line by line"],
  ["labor", "12. Labor by build phase"],
  ["pricing", "13. Fit-out, pricing & the two cost views"],
  ["math", "14. How every number is calculated"],
  ["workflow", "15. Saving, submitting & the approval workflow"],
  ["planner", "16. The annual program planner"],
  ["faq", "17. Troubleshooting & FAQ"],
] as const;

export default async function BargeManualPage() {
  await requireUser();

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header + actions (hidden when printing) */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/barge" className={buttonCls("secondary")}>
          <ArrowLeft size={16} strokeWidth={2} />
          Back to Barge Program
        </Link>
        <PrintButton />
      </div>

      <article className="rounded-xl border border-line bg-white p-8 shadow-[0_1px_2px_rgba(13,36,56,0.05)] print:rounded-none print:border-0 print:p-0 print:shadow-none">
        {/* Title block */}
        <header className="mb-8 border-b border-line pb-6">
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-brand-600">
            SMW Job Plans — Barge Program
          </p>
          <h1 className="mt-1 text-[1.8rem] font-semibold tracking-tight text-ink-900">
            Barge Program instruction manual
          </h1>
          <p className="mt-2 text-sm text-ink-600">
            A complete, plain-language guide to quoting a new-build deck barge:
            what every input means, what the model assumes on your behalf, how
            much detail to use at each stage, and how a quote moves from a
            first rough number to an approved price. Print this page or save
            it as a PDF with the <em>Print / Save PDF</em> button (or{" "}
            <Kbd>Ctrl</Kbd>+<Kbd>P</Kbd> / <Kbd>⌘</Kbd>+<Kbd>P</Kbd>).
          </p>
        </header>

        {/* Table of contents */}
        <nav aria-label="Contents" className="mb-10">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
            Contents
          </h2>
          <ol className="mt-2 grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="text-brand-600 hover:underline print:text-ink-900"
                >
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="space-y-10 text-sm leading-6 text-ink-900">
          {/* ------------------------------------------------------------ */}
          <Section id="overview" title="1. What the Barge Program is">
            <P>
              The Barge Program is the part of this app used to price{" "}
              <strong>building a brand-new deck barge</strong> — as opposed to
              the Job Plan Wizard, which prices repair and fabrication work.
              You describe the barge (its size, its steel, the hours to build
              it) and the program turns that description into a{" "}
              <strong>cost to build</strong>, a <strong>suggested selling
              price</strong>, and a <strong>margin</strong> — the money left
              over after costs. You never type a total: every dollar figure is
              calculated from the inputs you enter, and recalculates instantly
              whenever you change one.
            </P>
            <P>
              A finished estimate is called a <strong>quote</strong>. Quotes
              follow the same approval path as job plans: a quote starts as a{" "}
              <strong>draft</strong> that its creator can edit freely. When it
              is ready, it is <strong>submitted</strong>, which locks it and
              sends it to the approvers. An approver can{" "}
              <strong>approve</strong> it, <strong>request changes</strong>{" "}
              (which unlocks it for another editing round), or{" "}
              <strong>reject</strong> it. Bigger quotes need more than one
              approval — see{" "}
              <a href="#workflow" className="text-brand-600 hover:underline">
                section 15
              </a>
              .
            </P>
            <Figure>
              draft&nbsp;&nbsp;→&nbsp;&nbsp;submitted&nbsp;&nbsp;→&nbsp;&nbsp;approved
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;↑&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├──&nbsp;changes
              requested&nbsp;──→&nbsp;back to editing&nbsp;──→&nbsp;resubmit
              (new version)
              <br />
              &nbsp;&nbsp;&nbsp;&nbsp;└───────────┴──&nbsp;rejected&nbsp;(final)
            </Figure>
            <P>
              Everything in this manual happens on three screens, all reached
              from <strong>Barge Program</strong> in the left-hand menu:
            </P>
            <Ul
              items={[
                <>
                  the <strong>landing page</strong> — the list of every quote
                  and saved configuration (section 4);
                </>,
                <>
                  the <strong>Rough Quote Builder</strong> — turns barge
                  dimensions into a priced estimate in seconds (sections
                  5–8); and
                </>,
                <>
                  the <strong>quote workbench</strong> — the full, editable,
                  line-by-line estimate where quotes are finished, priced, and
                  submitted (sections 10–15).
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="roles" title="2. Roles & permissions">
            <P>
              What you can do depends on your role (shown in the bottom-left
              corner of the sidebar). Roles are assigned by an admin on the
              Settings page.
            </P>
            <MTable
              head={["Role", "What they can do in the Barge Program"]}
              rows={[
                [
                  "Estimator",
                  "Create quotes and configurations, edit their own quotes while in draft or changes-requested status, submit them for approval, and delete their own drafts and configurations.",
                ],
                [
                  "Approver",
                  "Open submitted quotes and approve, reject, or request changes. Approvers cannot edit quote content, and nobody — not even an admin — can approve a quote they created themselves.",
                ],
                [
                  "Admin",
                  "Everything above, on any quote: edit any draft or changes-requested quote, submit on behalf of the creator, approve (except their own quotes), and delete any quote or configuration in any status.",
                ],
                [
                  "Viewer",
                  "Read-only. Viewers can open every screen and see every number, but all input boxes are greyed out and no workflow buttons appear.",
                ],
              ]}
            />
            <P>
              These rules are enforced by the database, not just by the
              screen: even if a button were somehow visible, the server would
              refuse an action your role does not permit.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section
            id="granularity"
            title="3. Three levels of detail — which tool to use when"
          >
            <P>
              The most important idea in the Barge Program is that you can
              work at <strong>three levels of detail</strong>, from very
              coarse to very fine, and move from one to the next without
              retyping anything. Start coarse, and add detail only when the
              conversation deserves it.
            </P>
            <MTable
              head={["Level", "Where", "What you enter", "Good for"]}
              rows={[
                [
                  "1. Rough (parametric)",
                  "Rough Quote Builder",
                  "About twenty numbers describing the whole barge: dimensions, plate thicknesses, and market rates. The model estimates all the steel and labor for you from those.",
                  "A first ballpark in a phone call, testing “what if it were 150 feet instead of 120?”, or comparing steel-price scenarios. Seconds of work.",
                ],
                [
                  "2. Template takeoff",
                  "New quote menu on the landing page",
                  "Nothing — you start from a reference takeoff that already lists every steel component and build phase for the 150' × 54' × 8' barge, then adjust what differs.",
                  "A serious quote for a barge similar to one already engineered. Minutes of work.",
                ],
                [
                  "3. Full component takeoff",
                  "Quote workbench",
                  "Every steel line individually — quantity, weight, purchase yield, and price per pound — plus hours for each build phase and every fit-out cost.",
                  "The final negotiated quote that goes for approval. As accurate as the takeoff you put into it.",
                ],
              ]}
            />
            <P>
              The levels connect: the Rough Quote Builder&rsquo;s{" "}
              <strong>Create editable quote</strong> button converts its
              whole-barge estimate into a full component takeoff (level 3)
              automatically, splitting the estimated steel and hours into
              named lines and phases you can then refine one at a time. A
              rough quote is never a dead end — it is the first draft of the
              real one.
            </P>
            <Callout>
              Rule of thumb: quote a <em>conversation</em> with level 1, quote
              a <em>customer</em> with level 3. Never send a rough number to
              approval — approvers see exactly the same workbench you do, and
              a takeoff of nine estimated &ldquo;lot&rdquo; lines tells them
              much less than a real component list.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="landing" title="4. A tour of the landing page">
            <P>
              Open <strong>Barge Program</strong> in the left-hand menu. The
              page has three areas, top to bottom:
            </P>
            <H3>The quotes table</H3>
            <P>
              Every quote in the system, newest first, with its customer,
              status badge, and headline numbers. Click a quote&rsquo;s name
              to open it in the workbench. The <strong>Margin</strong> pill is
              color-coded so problem quotes stand out at a glance: red below
              0%, amber below 10%, green at 10% or better. (Margins on this
              page are <em>direct contribution</em> — costs before overhead;
              section 13 explains the difference.)
            </P>
            <Shot caption="A row of the quotes table — the engineer reference quote priced at $1,400,000. Click the name to open it; the trash can deletes it (drafts you own, or any quote if you are an admin).">
              <MockLandingRow />
            </Shot>
            <H3>The buttons in the top-right corner</H3>
            <Ul
              items={[
                <>
                  <strong>Rough quote builder</strong> — opens the parametric
                  builder (section 5).
                </>,
                <>
                  <strong>New quote</strong> — opens a menu of starting
                  points: the two reference takeoffs, a blank quote, and one
                  entry for each saved configuration (section 9).
                </>,
              ]}
            />
            <H3>The two cards along the bottom</H3>
            <Ul
              items={[
                <>
                  <strong>Saved configurations</strong> — the dimension-and-rate
                  sets saved from the Rough Quote Builder (section 7). Click a
                  name to reopen it in the builder.
                </>,
                <>
                  <strong>Annual program</strong> — a planning scratchpad that
                  shows how many barges per year the yard&rsquo;s labor force
                  could build (section 16).
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="rough" title="5. The Rough Quote Builder">
            <P>
              Click <strong>Rough quote builder</strong> on the landing page.
              The screen is a form on the left and results on the right. Type
              a number in any box on the left and every number on the right
              updates immediately — there is no &ldquo;calculate&rdquo;
              button, and nothing is saved until you choose to save it, so
              you can experiment freely.
            </P>
            <P>
              The four tiles across the top are the headline answer. With the
              builder&rsquo;s default inputs — a 120&prime; × 40&prime; ×
              8&prime; barge with 4 spud wells — they read:
            </P>
            <Shot caption="The result tiles for the default 120' × 40' × 8' configuration. Net steel is what ends up in the barge; “ordered” is the larger amount you must buy (section 6 explains yield).">
              <MockRoughTiles />
            </Shot>
            <P>
              Below the tiles, the <strong>build-up table</strong> shows where
              those totals come from, line by line: the weight of the deck,
              bottom, sides, ends, and bulkheads computed from the dimensions
              you entered; the plate allowance; the framing factor; and then
              steel cost, labor, blast &amp; paint, spud wells, and fittings
              down to the <strong>rough direct cost</strong> and the{" "}
              <strong>suggested price</strong>. Reading this table top to
              bottom is the fastest way to understand the whole model.
            </P>
            <P>Under the input form sit the two buttons that make the rough
              estimate permanent (estimators and admins only):
            </P>
            <Ul
              items={[
                <>
                  <strong>Save configuration</strong> — stores the current set
                  of inputs under a name so it can be reloaded or reused later
                  (section 7). Type a name in the box first — the button stays
                  greyed out until you do.
                </>,
                <>
                  <strong>Create editable quote</strong> — converts the rough
                  estimate into a full, editable component takeoff and opens
                  it in the workbench (section 9).
                </>,
              ]}
            />
            <Callout>
              The defaults are deliberately conservative — industry-benchmark
              steel prices and first-of-a-kind labor hours. The idea is that
              every number states the case that must be beaten: if the yard
              believes it can build faster or buy cheaper, change the input
              and watch what that belief is worth.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="config" title="6. Configuration inputs, field by field">
            <P>
              The form has three groups. Each field shows a small grey hint
              under its label with its unit of measure and, where one exists,
              the benchmark it was calibrated to. This section walks through
              every field in order.
            </P>

            <H3>Principal dimensions — the barge itself</H3>
            <MTable
              head={["Field", "What it means"]}
              rows={[
                [
                  "Length (ft)",
                  "The barge's overall length in feet, bow to stern.",
                ],
                [
                  "Beam (ft)",
                  "The barge's width in feet, side to side.",
                ],
                [
                  "Depth (ft)",
                  "The height of the hull in feet, from the flat bottom up to the deck. (This is the size of the steel box — not how deep the barge sits in the water.)",
                ],
                [
                  "Spud wells (count)",
                  "How many spud wells the barge gets. A spud well is a vertical tube through the hull that holds a spud — a long steel post lowered to the river bottom to pin the barge in place, which a crane barge needs to work safely. Each well adds a fixed cost (see the spud well package rate below) and its structure is part of the plate allowance.",
                ],
              ]}
            />

            <H3>Structure — how the barge is built</H3>
            <P>
              These control how much steel the model puts into the hull. The
              defaults reproduce the naval architect&rsquo;s engineered design
              for the 150&prime; × 54&prime; × 8&prime; barge, so for a
              similar style of barge you can usually leave them alone.
            </P>
            <MTable
              head={["Field", "What it means"]}
              rows={[
                [
                  "Deck / bottom plate (inches)",
                  "The thickness of the steel plate used for the deck and the bottom of the hull. Thicker plate = a stronger, heavier, more expensive barge. Default ½ inch.",
                ],
                [
                  "Side shell plate (inches)",
                  "Thickness of the plate on the two long sides of the hull. Default ⅜ inch.",
                ],
                [
                  "Bulkhead plate (inches)",
                  "Thickness of the internal walls (bulkheads) that divide the hull into compartments. Default 5/16 inch.",
                ],
                [
                  "Long. BHD spacing (ft)",
                  "How far apart the longitudinal bulkheads are — the internal walls running the length of the barge. The model divides the beam by this spacing to work out how many are needed (the design reference is 11 feet). Smaller spacing = more walls = more steel.",
                ],
                [
                  "WT BHD spacing (ft)",
                  "How far apart the watertight (WT) transverse bulkheads are — the walls running across the barge that seal compartments off from each other, so a leak floods one compartment instead of the whole hull. The model divides the length by this spacing (reference: about 30 feet).",
                ],
                [
                  "Plate allowance (%)",
                  "Extra plate weight, as a percentage, added on top of the simple box shape for everything the box leaves out: the sloped rake ends, the spud well structure, plate laps, and brackets. Calibrated to 22% against the engineered design — see section 8.",
                ],
                [
                  "Framing & trusses (% of plate weight)",
                  "The internal skeleton — beams, stiffeners, and trusses that keep the plate rigid — estimated as a percentage of total plate weight. Calibrated to 39%. Together with the plate allowance this turns the plate estimate into total net steel.",
                ],
                [
                  "Purchase yield (%)",
                  "What share of the steel you buy actually ends up in the barge. Plate comes in standard mill sizes, so there is always offcut and scrap: at 88% yield, buying 100 lbs of steel puts 88 lbs into the vessel. The model divides net weight by this yield to compute what to order. The engineer's real order list runs 80–100% depending on the item.",
                ],
              ]}
            />

            <H3>Market rates — challenge these</H3>
            <P>
              These are the money assumptions. Unlike the structure group,
              they are opinions about the market and the yard&rsquo;s own
              productivity — the group heading literally says{" "}
              <em>&ldquo;challenge these&rdquo;</em>. Some fields carry small
              dashed <strong>quick-set buttons</strong> that fill in a
              benchmark value with one click, so you can flip between
              scenarios instantly:
            </P>
            <Shot caption="Two fields from the Market rates group with their quick-set buttons. Clicking “yard 8.7” fills the field with the yard's claimed productivity; clicking “industry 30” restores the conservative benchmark.">
              <MockConfigFields />
            </Shot>
            <MTable
              head={["Field", "What it means"]}
              rows={[
                [
                  "Steel price ($/lb)",
                  "The blended price paid per pound of steel across plate and shapes. Quick-sets: the $0.55 industry benchmark and the $0.78 seen in the yard quote.",
                ],
                [
                  "Hours per net ton",
                  "Labor productivity: how many worker-hours it takes to turn one ton (2,000 lbs) of net steel into finished barge. This is the single most powerful input on the page. Benchmarks: 25–35 for a first-of-a-kind build (“first-article”), 10–15 once a yard is building the same design repeatedly (“serial”), and 8.7 is the yard's own claim. The default of 30 is deliberately the conservative end.",
                ],
                [
                  "Labor rate ($/hr)",
                  "What one worker-hour costs, fully burdened — wages plus taxes, benefits, and insurance. Industry benchmark ≈ $45; the yard's payroll figure is $33.86.",
                ],
                [
                  "Blast & paint ($/sqft)",
                  "Cost per square foot to abrasive-blast and coat the exterior of the hull. Applied to the whole outside surface (deck, bottom, sides, ends). Calibrated at $4.00.",
                ],
                [
                  "Spud well package ($ per well)",
                  "The all-in cost of one spud well including the spud itself. Calibrated at $18,000; multiplied by the spud well count.",
                ],
                [
                  "Fittings & hatches ($/sqft of deck)",
                  "Deck hardware — manholes, hatches, kevels (the posts lines are tied to), rub rail — estimated per square foot of deck area. Calibrated at $4.50.",
                ],
                [
                  "Target contribution (%)",
                  "The profit margin you are aiming for, as a percentage of the selling price. Only used to compute the suggested price — it never changes cost. At the default 25%, a $750,000 cost suggests a $1,000,000 price.",
                ],
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="saved" title="7. Saved configurations">
            <P>
              A <strong>configuration</strong> is a named set of Rough Quote
              Builder inputs — all the dimensions, structure factors, and
              market rates as one package. Save one whenever a parameter set
              is worth coming back to: a barge size you quote often, or a
              scenario (&ldquo;140-footer at yard steel prices&rdquo;) you
              want to compare against later.
            </P>
            <Steps
              items={[
                <>
                  Set the inputs the way you want them in the Rough Quote
                  Builder.
                </>,
                <>
                  Type a recognizable name in the{" "}
                  <strong>Configuration name</strong> box at the bottom of the
                  form.
                </>,
                <>
                  Click <strong>Save configuration</strong>. (When a saved
                  configuration is already loaded, the button reads{" "}
                  <strong>Update configuration</strong> and overwrites it
                  instead.)
                </>,
              ]}
            />
            <P>Saved configurations appear in three places:</P>
            <Ul
              items={[
                <>
                  the <strong>Load saved configuration</strong> dropdown at
                  the top of the builder form — pick one to load its values;
                </>,
                <>
                  the <strong>Saved configurations</strong> card on the
                  landing page — click a name to open it in the builder; and
                </>,
                <>
                  the <strong>New quote</strong> menu on the landing page —
                  one entry per configuration, so a full editable quote can
                  be created from it in one click.
                </>,
              ]}
            />
            <P>
              A configuration only stores <em>inputs</em>. Editing or deleting
              one never changes any quote that was created from it — the
              quote took a copy of the numbers at the moment it was created.
              Estimators can delete their own configurations; admins can
              delete any.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section
            id="assumptions"
            title="8. The assumptions built into the model"
          >
            <P>
              The Rough Quote Builder trades detail for speed, and it can only
              do that by assuming things. Every assumption is listed here, so
              you always know what the model decided on your behalf — and
              which knob to turn when you disagree.
            </P>
            <H3>Physical assumptions</H3>
            <Ul
              items={[
                <>
                  <strong>Steel weighs 40.8 lbs per square foot per inch of
                  thickness.</strong> This is a physical constant of steel
                  plate, and every plate weight in the model is area ×
                  thickness × 40.8.
                </>,
                <>
                  <strong>The hull is treated as a rectangular box.</strong>{" "}
                  Deck and bottom are length × beam; sides are length × depth;
                  ends are beam × depth. Real barges have raked (sloped) ends
                  and spud well penetrations — that steel is not drawn, it is
                  covered by the <em>plate allowance</em> percentage.
                </>,
                <>
                  <strong>Bulkhead counts come from spacing.</strong> The
                  number of longitudinal bulkheads is the beam divided by
                  their spacing (minus one, since the sides are not
                  bulkheads); the number of watertight transverse bulkheads is
                  the length divided by their spacing. Ends and headlog are
                  assumed at deck-plate thickness.
                </>,
                <>
                  <strong>Framing is proportional to plate.</strong> The
                  internal skeleton is not itemized; it is a flat percentage
                  (default 39%) of total plate weight.
                </>,
              ]}
            />
            <H3>Calibration — where 22% and 39% come from</H3>
            <P>
              The plate allowance (22%) and framing factor (39%) were not
              picked out of the air. They were tuned so that when you type in
              the naval architect&rsquo;s barge — 150&prime; × 54&prime; ×
              8&prime; — the model reproduces the engineered takeoff&rsquo;s
              total of roughly <strong>807,000 lbs net steel to within
              0.5%</strong>. In other words, the shortcut model is anchored to
              one fully-engineered design, and its accuracy on other barges
              depends on how similar they are to that one. A very different
              vessel (a tank barge, an unusually deep hull) deserves its own
              engineering — or at minimum a hard look at those two
              percentages.
            </P>
            <H3>Commercial assumptions</H3>
            <Ul
              items={[
                <>
                  <strong>Defaults are conservative on purpose.</strong> Steel
                  at the $0.55/lb industry benchmark and 30 hrs/ton
                  first-article labor. The yard&rsquo;s claim of 8.7 hrs/ton is
                  available as a one-click quick-set, but it is treated as the
                  case to prove, not the starting point.
                </>,
                <>
                  <strong>Labor hours scale with tonnage.</strong> Hours =
                  net tons × hours-per-ton. When a rough quote is converted to
                  an editable takeoff, those hours are split across the six
                  standard build phases in fixed shares (about 26% shell
                  assembly, 29% frames &amp; trusses, 11% bulkheads, 23% deck,
                  7% spud wells &amp; headlog, 4% fit-out and launch prep).
                </>,
                <>
                  <strong>The $1.50/lb crosscheck.</strong> The yard&rsquo;s
                  own rule of thumb — total build cost ≈ net pounds × $1.50 —
                  is shown beside every workbench quote as a sanity check. It
                  never feeds the math; it is there so a takeoff that drifts
                  far from the rule of thumb gets questioned.
                </>,
                <>
                  <strong>Overhead defaults to 35% of labor cost</strong> and
                  appears only in the fully-absorbed view (section 13).
                  Contingency defaults to 0% — matching the yard quote, which
                  carried none.
                </>,
                <>
                  <strong>The suggested price is cost-plus.</strong> Suggested
                  price = direct cost ÷ (1 − target %). It is a starting
                  point for negotiation, not a market price — there is no
                  comparable-sales data behind it, and the workbench labels
                  the sales price “negotiated” for exactly that reason.
                </>,
                <>
                  <strong>Planning constants.</strong> The annual program
                  planner assumes 1,800 productive hours per direct worker
                  per year, and starts from a pool of 46 direct-trade workers
                  (both editable on the card).
                </>,
              ]}
            />
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="create" title="9. Creating an editable quote">
            <P>
              There are four ways to create a quote; all of them end at the
              same workbench.
            </P>
            <MTable
              head={["Starting point", "Where", "What you get"]}
              rows={[
                [
                  "Engineer reference takeoff",
                  "New quote menu",
                  "The naval architect's updated order list for the 150' × 54' × 8' deck/crane barge (TSG, Jul 2026) — real component lines with per-line purchase yields. About 403.5 net tons. The best starting point for a serious quote on a similar barge.",
                ],
                [
                  "Original yard quote",
                  "New quote menu",
                  "The yard's earlier budget for the same barge, preserved as a comparison baseline — original quantities at a uniform 88.9% yield; reproduces the historical $1,013,617 build cost at $45/hr. Useful for “how does our number compare?”, not as a fresh start.",
                ],
                [
                  "Blank quote",
                  "New quote menu",
                  "An empty takeoff with the six standard build phases at zero hours — for a vessel the templates don't fit. Everything must be entered by hand.",
                ],
                [
                  "From a configuration",
                  "New quote menu (saved configurations) or the Create editable quote button in the Rough Quote Builder",
                  "The rough model's output converted into a takeoff: nine estimated steel lines (deck, bottom, sides, ends, bulkheads, allowance, and three framing shares), hours split across the six phases, fit-out costs filled in, and the suggested price pre-entered as the sales price.",
                ],
              ]}
            />
            <P>
              New quotes are created in <strong>draft</strong> status with an
              automatic name (for example{" "}
              <em>&ldquo;Rough 120×40 — Feb 7&rdquo;</em>). Rename it in the
              workbench to something the approvers will recognize. You can
              also open any existing quote and click{" "}
              <strong>Duplicate</strong> to get a fresh draft copy — the
              normal way to quote a variation without disturbing the
              original.
            </P>
            <Callout>
              A takeoff created from a configuration is estimates all the way
              down — nine &ldquo;lot&rdquo; lines of model output, not a
              parts list. Treat each line as a placeholder to be challenged
              and replaced with real components as the quote firms up.
            </Callout>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="workbench" title="10. The quote workbench — a tour">
            <P>
              Click any quote&rsquo;s name on the landing page to open the
              workbench. It is one screen with everything about the quote on
              it. From top to bottom:
            </P>
            <Ul
              items={[
                <>
                  <strong>Header</strong> — the status badge, the version
                  number (once a quote has been resubmitted), the quote name
                  (click and type to rename while editable), the{" "}
                  <strong>Direct contribution / Fully absorbed</strong> view
                  toggle (section 13), and the <strong>Duplicate</strong> and{" "}
                  <strong>Delete</strong> buttons.
                </>,
                <>
                  <strong>Five result tiles</strong> — the headline numbers,
                  recalculated on every keystroke (figure below).
                </>,
                <>
                  <strong>Left column</strong> — customer &amp; notes, labor
                  phases, fit-out &amp; pricing inputs, and the workflow cards
                  (submit / approve).
                </>,
                <>
                  <strong>Right column</strong> — the steel takeoff table
                  (section 11), the per-unit P&amp;L that lays the quote out
                  like a small income statement, and the margin sensitivity
                  grid.
                </>,
              ]}
            />
            <Shot caption="The five result tiles for the engineer reference takeoff at a $1,400,000 sales price, in the Direct contribution view.">
              <MockKpis />
            </Shot>
            <P>Reading the tiles left to right:</P>
            <Ul
              items={[
                <>
                  <strong>Cost to build</strong> — everything it costs to
                  build one barge in the current view (direct or fully
                  absorbed), with net tons and ordered pounds underneath.
                </>,
                <>
                  <strong>Sales price</strong> — the negotiated selling
                  price, typed in by you (section 13). Nothing computes it;
                  the hint says &ldquo;no market comp — negotiated&rdquo; as a
                  reminder.
                </>,
                <>
                  <strong>Contribution / margin per unit</strong> — sales
                  price minus cost, in dollars and as a percentage of price.
                </>,
                <>
                  <strong>Margin per labor hour</strong> — the margin divided
                  by total build hours: what one hour of yard capacity earns
                  building this barge. This is the number to compare against
                  repair work when deciding whether a build is worth the
                  hours it consumes. The hint shows hours per net ton, the
                  productivity measure benchmarked in section 6.
                </>,
                <>
                  <strong>Price @ target</strong> — the price that would hit
                  the target contribution percentage exactly, with breakeven
                  (the cost) underneath. If negotiation lands below breakeven,
                  the quote loses money.
                </>,
              ]}
            />
            <H3>The margin sensitivity grid</H3>
            <P>
              The bottom-right card answers &ldquo;what if we&rsquo;re
              wrong?&rdquo; without touching the quote. Rows flex total labor
              hours from 30% under to 30% over the estimate; columns flex the
              blended steel price 15% either way. Each cell is the resulting
              margin at the current sales price, colored like a traffic
              light, with the current estimate outlined:
            </P>
            <Shot caption="The sensitivity grid for the engineer takeoff at $1,400,000. The boxed cell is the current estimate (25%). Even at 30% more hours and 15% dearer steel — the bottom-right corner — the quote still clears 14%.">
              <MockSensitivity />
            </Shot>
            <P>
              A quote whose bottom-right corner stays green can absorb bad
              news; a quote that goes red one cell away from the center is
              priced on a knife&rsquo;s edge. Approvers read this grid — it
              is worth glancing at before you submit.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="takeoff" title="11. The steel takeoff, line by line">
            <P>
              The takeoff table is the heart of the quote: every piece of
              steel, organized into four fixed sections —{" "}
              <strong>Plating</strong>, <strong>Deck framing</strong>,{" "}
              <strong>Bottom &amp; side framing</strong>, and{" "}
              <strong>Truss system</strong>. Each section shows its own
              subtotal row and a dashed <strong>+</strong> button to add a
              line to it.
            </P>
            <Shot caption="The Plating section of the engineer takeoff (first line shown). White boxes are editable; the three grey figures on the right are computed. The subtotal row adds up the whole section.">
              <MockTakeoff />
            </Shot>
            <P>
              Each line has five numbers you type and three the app computes:
            </P>
            <MTable
              head={["Column", "You type or computed?", "Meaning"]}
              rows={[
                [
                  "Item",
                  "You type",
                  "What the steel is, in your words — e.g. “½″ plate 40×10 — deck & bottom shell”. Put sizes and grades here; the description is for the humans approving the quote.",
                ],
                [
                  "Qty",
                  "You type",
                  "How many of the unit (next column) you need.",
                ],
                [
                  "Unit",
                  "You type",
                  "What “one” means for this line: ft (linear feet of a shape), plates (whole mill plates), each (individual pieces), or lot (the line is one bundle — quantity 1, with the whole weight in Lb/unit; the rough-quote conversion uses this).",
                ],
                [
                  "Lb/unit",
                  "You type",
                  "The weight of one unit in pounds — one foot of the shape, one plate, one piece, or the whole lot.",
                ],
                [
                  "Yield %",
                  "You type",
                  "The purchase yield for this line (section 6): what share of purchased steel ends up in the barge. The engineer's list uses 80–100% depending on the item; standard shapes cut with little waste score high, plate that nests badly scores low.",
                ],
                [
                  "$/lb",
                  "You type",
                  "The purchase price per pound for this line. Plate and shapes usually carry different prices (the references use $0.75 plate / $0.85 shapes).",
                ],
                [
                  "Net lbs",
                  "Computed",
                  "Qty × lb/unit — the steel that ends up in the barge.",
                ],
                [
                  "Ordered",
                  "Computed",
                  "Net lbs ÷ yield — the larger amount you must actually buy.",
                ],
                [
                  "Cost",
                  "Computed",
                  "Ordered lbs × $/lb — what this line costs. You pay for everything you order, scrap included.",
                ],
              ]}
            />
            <P>
              The <strong>×</strong> at the end of a row deletes the line;
              the <strong>Total steel</strong> row at the bottom adds up the
              whole takeoff. Remember that nothing is stored until you click{" "}
              <strong>Save quote</strong> (section 15).
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="labor" title="12. Labor by build phase">
            <P>
              The <strong>Labor by build phase</strong> card on the left is
              the hours side of the quote. A phase is one stage of
              construction; new quotes start with the six standard phases in
              build order:
            </P>
            <Ul
              items={[
                <>Bottom &amp; side shell assembly</>,
                <>Internal frames &amp; trusses</>,
                <>WT &amp; longitudinal bulkheads</>,
                <>Deck plating &amp; framing</>,
                <>Spud wells &amp; headlog</>,
                <>Fit-out, launch prep &amp; QC</>,
              ]}
            />
            <P>
              Enter the estimated worker-hours for each phase. Rename phases,
              remove them with the <strong>×</strong>, or click{" "}
              <strong>Add phase</strong> for extra rows — the math only cares
              about the total. Below the phases sits the{" "}
              <strong>labor rate</strong> ($ per hour, fully burdened; the
              references quote $45, actual burdened payroll is $33.86), and a
              grey summary showing total hours × rate = labor cost, plus{" "}
              <strong>hours per net ton</strong> with its benchmarks — the
              honesty check on the whole labor estimate. If your phases sum
              to 8 hrs/ton on a first-of-a-kind build, the estimate is
              claiming world-class productivity, and an approver will ask
              why.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section
            id="pricing"
            title="13. Fit-out, pricing & the two cost views"
          >
            <H3>Fit-out and indirect inputs</H3>
            <MTable
              head={["Field", "What it means"]}
              rows={[
                [
                  "Blast & paint ext. ($)",
                  "One lump sum for blasting and coating the exterior. The rough model estimates it from surface area; here it is a single dollar figure you can replace with a vendor quote.",
                ],
                [
                  "Spud wells & spuds ($)",
                  "Lump sum for the spud well packages including the spuds themselves.",
                ],
                [
                  "Hatches & deck fittings ($)",
                  "Lump sum for manholes, hatches, rub rail, kevels, and other deck hardware.",
                ],
                [
                  "Overhead on labor (%)",
                  "The share of yard overhead (supervision, utilities, equipment, facilities) charged to this build, as a percentage of labor cost. Default 35%. Only counted in the Fully absorbed view — see below.",
                ],
                [
                  "Contingency (%)",
                  "A safety percentage added on top of all costs for the unknown. Default 0% — the yard quote carried none — so any contingency is a deliberate choice you make.",
                ],
                [
                  "Sales price ($)",
                  "The actual selling price — typed in from negotiation, never computed. This is the number margins are measured against, and the number the approval thresholds look at.",
                ],
                [
                  "Target contribution (%)",
                  "Drives the “Price @ target” tile and the green “Price for X% target” row, telling you what to ask for. Changing it never changes cost or margin at the current price.",
                ],
              ]}
            />
            <H3>Direct contribution vs. fully absorbed</H3>
            <P>
              The toggle in the header switches how the quote is judged, and
              it is worth understanding because the two views answer
              different questions:
            </P>
            <MTable
              head={["View", "What counts as cost", "The question it answers"]}
              rows={[
                [
                  "Direct contribution (default)",
                  "Steel + labor + fit-out (× contingency). Overhead is excluded.",
                  "“Does this build add money on top of a yard whose fixed costs repair work already pays for?” The right lens while barge building is incremental work.",
                ],
                [
                  "Fully absorbed",
                  "The same plus overhead on labor.",
                  "“Would this price survive if barge building had to carry its own share of the yard?” The right lens for pricing floors and long-run decisions — if the yard staffed up around building barges, absorbed margin is the real margin.",
                ],
              ]}
            />
            <P>
              Everything on the screen — tiles, P&amp;L, sensitivity grid —
              follows the toggle. The landing page always shows direct
              contribution. A quote can look comfortable on a direct basis
              and thin on an absorbed one; check both before submitting.
            </P>
            <H3>The crosscheck</H3>
            <P>
              The amber <strong>Crosscheck $1.50/lb net</strong> row compares
              your cost to the yard&rsquo;s rule of thumb (net pounds ×
              $1.50), with the difference in brackets. It has no effect on any
              number — but if your takeoff lands far from the rule of thumb,
              either you know exactly why, or something is wrong. Find out
              which before the approver asks.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="math" title="14. How every number is calculated">
            <P>
              The same formulas run live in the workbench and in the
              database, so the numbers you watch while typing are exactly the
              numbers that get saved and approved. Nothing else feeds the
              totals.
            </P>
            <Formulas
              rows={[
                ["Net lbs (line)", "qty × lb/unit"],
                ["Ordered lbs (line)", "net lbs ÷ (yield % ÷ 100)"],
                ["Steel cost (line)", "ordered lbs × $/lb"],
                ["Total hours", "sum of all phase hours"],
                ["Labor cost", "total hours × labor rate"],
                [
                  "Fit-out cost",
                  "blast & paint + spud wells + hatches & fittings",
                ],
                ["Overhead", "labor cost × overhead %"],
                [
                  "Direct cost",
                  "(steel + labor + fit-out) × (1 + contingency %)",
                ],
                [
                  "Absorbed cost",
                  "(steel + labor + fit-out + overhead) × (1 + contingency %)",
                ],
                ["Margin", "sales price − cost (per the current view)"],
                ["Margin %", "margin ÷ sales price"],
                ["Price @ target", "cost ÷ (1 − target % ÷ 100)"],
                ["Crosscheck", "total net lbs × $1.50"],
              ]}
            />
            <H3>A worked example — the engineer reference takeoff</H3>
            <P>
              Follow one quote through the math. The engineer template&rsquo;s
              nine steel lines total <strong>807,014 net lbs</strong> (403.5
              net tons); dividing each line by its yield and pricing it gives{" "}
              <strong>907,264 lbs ordered</strong> costing{" "}
              <strong>$706,212</strong>. The six phases hold{" "}
              <strong>3,500 hours</strong> at $45. Fit-out is $78,000 blast +
              $72,000 spud wells + $36,250 hatches. Sales price:{" "}
              <strong>$1,400,000</strong>.
            </P>
            <Formulas
              rows={[
                ["Steel cost", "$706,212 (from the nine lines)"],
                ["Labor cost", "3,500 hrs × $45 = $157,500"],
                ["Fit-out", "78,000 + 72,000 + 36,250 = $186,250"],
                [
                  "Direct cost",
                  "(706,212 + 157,500 + 186,250) × 1.00 = $1,049,962",
                ],
                ["Direct margin", "1,400,000 − 1,049,962 = $350,038 (25.0%)"],
                ["Overhead", "35% × 157,500 = $55,125"],
                ["Absorbed cost", "1,049,962 + 55,125 = $1,105,087"],
                [
                  "Absorbed margin",
                  "1,400,000 − 1,105,087 = $294,913 (21.1%)",
                ],
                ["Hours per net ton", "3,500 ÷ 403.5 = 8.7"],
                ["Margin per labor hr", "350,038 ÷ 3,500 = $100"],
                ["Crosscheck", "807,014 lbs × $1.50 = $1,210,521"],
              ]}
            />
            <P>
              These are the exact figures shown in the screenshots in section
              10. At a $1,400,000 sales price this quote needs{" "}
              <strong>3 approvals</strong> (section 15).
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section
            id="workflow"
            title="15. Saving, submitting & the approval workflow"
          >
            <H3>Saving</H3>
            <P>
              The workbench recalculates as you type, but nothing is stored
              until you save. The moment anything differs from the saved
              version, an amber <strong>Unsaved changes</strong> bar appears
              at the top with two buttons: <strong>Save quote</strong> (write
              everything — name, customer, notes, every line, every phase,
              every rate — to the database) and <strong>Discard</strong>{" "}
              (throw the edits away and reload what was saved). If you leave
              the page without saving, unsaved edits are lost. The Submit
              button is disabled while the bar is showing, so you can never
              submit something different from what is on screen.
            </P>
            <H3>Submitting</H3>
            <Shot caption="The submit card (left) as the estimator sees it on a draft, and the approval card (right) as an approver sees it on a submitted quote.">
              <MockWorkflowCards />
            </Shot>
            <P>
              When the quote is ready, click <strong>Submit quote</strong>.
              The server checks three things and refuses with a plain message
              if any fails: the quote must have a{" "}
              <strong>sales price greater than zero</strong>, at least one{" "}
              <strong>steel takeoff line</strong>, and at least one{" "}
              <strong>labor phase</strong>. On success the quote flips to{" "}
              <strong>submitted</strong>: every field locks, and the quote
              waits for approvers. Only the quote&rsquo;s creator (or an
              admin) can submit it.
            </P>
            <H3>How many approvals a quote needs</H3>
            <P>
              The requirement is driven by the <strong>sales price</strong>{" "}
              (thresholds are configurable by admins; these are the
              defaults). Barge quotes share the same thresholds as job plans:
            </P>
            <MTable
              head={["Sales price", "Required"]}
              rows={[
                ["Under $25,000", "1 approval"],
                ["$25,000 – $100,000", "2 approvals"],
                ["$100,000 and up", "3 approvals"],
              ]}
            />
            <P>
              Since a new-build barge virtually always exceeds $100,000,
              expect three approvals. The quote stays{" "}
              <strong>submitted</strong>, collecting approvals — the workbench
              shows a live <em>granted / required</em> count — until it has
              enough, then flips to <strong>approved</strong> automatically.
            </P>
            <H3>Acting on a submitted quote (approvers)</H3>
            <MTable
              head={["Action", "Comment", "What happens"]}
              rows={[
                [
                  "Approve",
                  "Optional",
                  "Records an approval for the current version. When approvals reach the required count, the quote becomes approved.",
                ],
                [
                  "Request changes",
                  "Required",
                  "Sends the quote back to the estimator in changes-requested status. It becomes editable again; when resubmitted, the version number goes up (v2, v3, …) and approvals start over from zero for the new version.",
                ],
                [
                  "Reject",
                  "Required",
                  "Final. A rejected quote is closed permanently — it cannot be edited or resubmitted. To pursue the work, duplicate it into a new draft. Approvers should use Request changes when a revision could fix it.",
                ],
              ]}
            />
            <H3>Guard rails</H3>
            <Ul
              items={[
                <>
                  <strong>No self-approval</strong> — you can never approve a
                  quote you created, even as an admin.
                </>,
                <>
                  <strong>Content locks outside editing states</strong> — the
                  takeoff, phases, and rates can only change while the quote
                  is in draft or changes-requested status; the database
                  enforces it.
                </>,
                <>
                  <strong>Version integrity</strong> — approvals are tied to
                  a specific version, so nothing approved ever differs from
                  what the approver saw.
                </>,
                <>
                  <strong>Audit trail</strong> — every submit, approval,
                  change request, and rejection is written permanently to the
                  audit log with who, when, and the key numbers at that
                  moment.
                </>,
              ]}
            />
            <H3>Deleting</H3>
            <P>
              <strong>Deleting a quote is permanent</strong> — the quote, its
              whole takeoff, and its approval history are removed with no
              undo. Estimators can delete <em>their own drafts only</em>;
              admins can delete any quote in any status. The button always
              asks for confirmation first.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="planner" title="16. The annual program planner">
            <P>
              The <strong>Annual program</strong> card on the landing page
              answers a different question from any single quote:{" "}
              <em>how many barges a year could the yard actually build?</em>{" "}
              Type a number of units per year next to any quote, and the card
              adds up the program: total revenue, total direct contribution,
              and — most importantly — total labor hours, shown as a bar
              against the yard&rsquo;s labor pool (direct workers × 1,800
              productive hours each; both the worker count and the mix are
              editable). The bar turns red with an{" "}
              <strong>OVER CAPACITY</strong> label when the program needs
              more hours than the pool holds, and an &ldquo;implied
              FTEs&rdquo; line shows how many full-time workers the program
              would consume.
            </P>
            <P>
              Two things to keep in mind. First, every hour committed to
              building barges is an hour <em>not</em> spent on repair work
              unless the yard hires — the card says so at the bottom. Second,
              the planner is a <strong>scratchpad</strong>: the unit mix you
              type is not saved anywhere and resets when you leave the page.
              It is for thinking, not for record-keeping.
            </P>
          </Section>

          {/* ------------------------------------------------------------ */}
          <Section id="faq" title="17. Troubleshooting & FAQ">
            <Faq
              q="Everything on the quote is greyed out — why can't I edit?"
              a="Three common reasons: the quote is submitted, approved, or rejected (content is locked outside draft and changes-requested status); you are not the quote's creator (only the creator or an admin may edit); or your role is viewer or approver, which never edits quote content."
            />
            <Faq
              q="The Submit button is greyed out."
              a="You have unsaved changes — the amber bar at the top of the workbench is showing. Click Save quote first (hovering over Submit shows “Save your changes first”)."
            />
            <Faq
              q="Submitting fails with “A sales price is required before submitting”."
              a="The Sales price field in the Fit-out, indirects & pricing card is zero. Enter the negotiated price — the approval thresholds are evaluated against it, so a quote can't go for approval without one."
            />
            <Faq
              q="Submitting fails saying the quote has no steel lines or no labor phases."
              a="A quote must contain at least one steel takeoff line and at least one labor phase before it can be submitted. Blank quotes start with empty takeoffs — add your lines and hours, save, then submit."
            />
            <Faq
              q="Why can't I approve this quote?"
              a="Either you created it (nobody can approve their own quote, even admins), it isn't in submitted status, or your role isn't approver or admin."
            />
            <Faq
              q="What's the difference between the two margins?"
              a="Direct contribution ignores yard overhead, on the logic that repair work already pays the yard's fixed costs, so a build only needs to beat its out-of-pocket costs. Fully absorbed charges overhead (default 35% of labor) to the build — the honest long-run view. Toggle between them in the workbench header; the landing page always shows direct."
            />
            <Faq
              q="My rough quote and the editable quote created from it show slightly different totals."
              a="Expected. The conversion rounds for readability — hours to the nearest 25 per phase, blast to the nearest $500, fittings to the nearest $250, and the sales price to the nearest $5,000 — and once created, the quote is an independent copy. Editing it never changes the configuration, and vice versa."
            />
            <Faq
              q="I changed a saved configuration — did my old quotes change too?"
              a="No. A quote copies the configuration's numbers at the moment it is created and never looks back. To re-quote with the new parameters, create a new quote from the updated configuration."
            />
            <Faq
              q="What does the crosscheck row mean, and is it a problem if it's far off?"
              a="It's the yard's rule of thumb — net pounds × $1.50 ≈ build cost — shown for sanity only; it never changes any number. A big gap isn't automatically wrong, but you should be able to explain it (unusual steel mix, exceptional productivity claim, heavy fit-out) before an approver asks."
            />
            <Faq
              q="Why does the version say v2?"
              a="An approver requested changes and the quote was resubmitted. Each resubmission increments the version, and approvals granted on earlier versions no longer count — every approver signs off on exactly the content in front of them."
            />
            <Faq
              q="Can I reopen a rejected quote?"
              a="No — rejection is final by design. Open the rejected quote, click Duplicate to get a fresh draft copy, revise, and submit that. If a quote is expected to come back after revisions, approvers should use Request changes rather than Reject."
            />
            <Faq
              q="I set units in the Annual program card and they disappeared."
              a="Expected — the planner is a scratchpad. The unit mix lives only on your screen and resets when you leave the page. Only the quotes themselves are saved."
            />
            <Faq
              q="Do I need to pick a customer?"
              a="No. A quote with no customer is marked “speculative” — useful for pricing exercises. You can attach the customer (imported from QuickBooks) any time while the quote is editable."
            />
          </Section>
        </div>

        <footer className="mt-12 border-t border-line pt-4 text-xs text-ink-400">
          SMW Job Plans — Barge Program instruction manual. Approval
          thresholds, roles, and the calibrated model factors described here
          are the system defaults; thresholds and roles are configurable by
          admins. The worked figures come from the engineer reference takeoff
          and the builder&rsquo;s default 120&prime; × 40&prime; × 8&prime;
          configuration.
        </footer>
      </article>
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6">
      <h2 className="mb-3 border-b border-line pb-2 text-lg font-semibold tracking-tight text-ink-900">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="pt-2 text-sm font-semibold text-ink-900">{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-ink-600">{children}</p>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-surface px-1 py-0.5 font-mono text-[0.7rem] text-ink-900">
      {children}
    </kbd>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="break-inside-avoid rounded-lg border border-brand-500/25 bg-brand-50 px-4 py-2.5 text-sm text-brand-700">
      {children}
    </div>
  );
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <pre className="break-inside-avoid overflow-x-auto rounded-lg bg-surface px-4 py-3 font-mono text-xs leading-5 text-ink-900">
      {children}
    </pre>
  );
}

function Steps({ items }: { items: React.ReactNode[] }) {
  return (
    <ol className="space-y-2 text-ink-600">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-navy-900 text-[0.65rem] font-semibold text-white">
            {i + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Ul({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 text-ink-600">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function MTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="break-inside-avoid overflow-hidden rounded-lg border border-line">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface/70 text-left text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3.5 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {rows.map((cells, i) => (
            <tr key={i} className="align-top">
              {cells.map((c, j) => (
                <td
                  key={j}
                  className={`px-3.5 py-2 ${
                    j === 0
                      ? "font-medium text-ink-900"
                      : "text-ink-600"
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Formulas({ rows }: { rows: [string, string][] }) {
  return (
    <div className="break-inside-avoid rounded-lg bg-surface px-4 py-3">
      <dl className="space-y-1 font-mono text-xs leading-5">
        {rows.map(([label, formula]) => (
          <div key={label} className="flex flex-wrap gap-x-2">
            <dt className="w-44 flex-none font-semibold text-ink-900">
              {label}
            </dt>
            <dd className="text-ink-600">= {formula}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <div className="break-inside-avoid">
      <p className="font-semibold text-ink-900">{q}</p>
      <p className="mt-0.5 text-ink-600">{a}</p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Illustrations — static reproductions of the Barge Program UI, built with
   the same design tokens as the live components so they match the app and
   print cleanly. All figures use numbers the real cost model produces (the
   default rough configuration and the engineer reference takeoff). Purely
   decorative: nothing here is interactive.
--------------------------------------------------------------------------- */

function Shot({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="break-inside-avoid" aria-hidden="true">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface/60 p-4">
        {children}
      </div>
      <figcaption className="mt-1.5 text-xs italic text-ink-400">
        {caption}
      </figcaption>
    </figure>
  );
}

function MockLandingRow() {
  return (
    <div className="min-w-[44rem] overflow-hidden rounded-lg border border-line bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface/70 text-left text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            <th className="px-4 py-2">Quote</th>
            <th className="px-4 py-2">Customer</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2 text-right">Net tons</th>
            <th className="px-4 py-2 text-right">Hours</th>
            <th className="px-4 py-2 text-right">Direct cost</th>
            <th className="px-4 py-2 text-right">Price</th>
            <th className="px-4 py-2 text-right">Margin</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-4 py-3 font-medium text-ink-900">
              Engineer rev — 150×54×8
            </td>
            <td className="px-4 py-3 text-ink-600">TSG Marine</td>
            <td className="px-4 py-3">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-ink-600">
                <span className="h-1.5 w-1.5 rounded-full bg-ink-400" />
                Draft
              </span>
            </td>
            <td className="px-4 py-3 text-right tabular-nums">404</td>
            <td className="px-4 py-3 text-right tabular-nums">3,500</td>
            <td className="px-4 py-3 text-right tabular-nums">$1,049,962</td>
            <td className="px-4 py-3 text-right tabular-nums">$1,400,000</td>
            <td className="px-4 py-3 text-right">
              <span className="inline-flex rounded-full border border-ok-600/25 bg-ok-50 px-2.5 py-0.5 text-xs font-medium tabular-nums text-ok-600">
                25.0%
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MockTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="min-w-44 rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
      <p className="text-[0.65rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
        {label}
      </p>
      <p className="mt-1.5 text-xl font-semibold leading-none tracking-tight tabular-nums text-ink-900">
        {value}
      </p>
      <p className="mt-1.5 text-xs text-ink-600">{hint}</p>
    </div>
  );
}

function MockRoughTiles() {
  return (
    <div className="flex min-w-fit gap-3">
      <MockTile
        label="Net steel"
        value="247 t"
        hint="494,007 lbs · 561,371 ordered"
      />
      <MockTile label="Labor hours" value="7,410" hint="30 hrs/ton × $45/hr" />
      <MockTile
        label="Rough direct cost"
        value="$784,444"
        hint="$3,176 per ton"
      />
      <MockTile
        label="Price @ 25%"
        value="$1,045,000"
        hint="$261,481 contribution"
      />
    </div>
  );
}

function MockConfigFields() {
  return (
    <div className="w-80 max-w-full space-y-3 rounded-xl border border-line bg-white p-4">
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-brand-600">
        Market rates — challenge these
      </p>
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink-600">
            Steel price
            <span className="block text-[0.68rem] text-ink-400">
              $/lb blended — industry ≈$0.55
            </span>
          </span>
          <span className="w-24 rounded-lg border border-line bg-white px-2 py-1.5 text-right text-sm tabular-nums text-ink-900">
            0.55
          </span>
        </div>
        <div className="mt-1 flex gap-1.5">
          <span className="rounded-md border border-dashed border-line px-2 py-0.5 text-[0.68rem] text-brand-600">
            industry $0.55
          </span>
          <span className="rounded-md border border-dashed border-line px-2 py-0.5 text-[0.68rem] text-brand-600">
            yard-quote $0.78
          </span>
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink-600">
            Hours per net ton
            <span className="block text-[0.68rem] text-ink-400">
              first-article 25–35; serial 10–15; yard claim 8.7
            </span>
          </span>
          <span className="w-24 rounded-lg border border-line bg-white px-2 py-1.5 text-right text-sm tabular-nums text-ink-900">
            30
          </span>
        </div>
        <div className="mt-1 flex gap-1.5">
          <span className="rounded-md border border-dashed border-line px-2 py-0.5 text-[0.68rem] text-brand-600">
            industry 30
          </span>
          <span className="rounded-md border border-dashed border-line px-2 py-0.5 text-[0.68rem] text-brand-600">
            serial 12
          </span>
          <span className="rounded-md border border-dashed border-line px-2 py-0.5 text-[0.68rem] text-brand-600">
            yard 8.7
          </span>
        </div>
      </div>
    </div>
  );
}

function MockKpis() {
  return (
    <div className="flex min-w-fit gap-3">
      <MockTile
        label="Cost to build"
        value="$1,049,962"
        hint="404 net t · 907,264 lbs ordered"
      />
      <MockTile
        label="Sales price"
        value="$1,400,000"
        hint="no market comp — negotiated"
      />
      <MockTile
        label="Direct contribution / unit"
        value="$350,038"
        hint="25.0% of price"
      />
      <MockTile
        label="Margin / labor hr"
        value="$100"
        hint="8.7 hrs/net ton"
      />
      <MockTile
        label="Price @ 25% target"
        value="$1,399,950"
        hint="breakeven $1,049,962"
      />
    </div>
  );
}

function MockCell({ v, faint }: { v: string; faint?: boolean }) {
  return (
    <span
      className={`block rounded-md border border-line bg-white px-2 py-1 text-right text-sm tabular-nums ${
        faint ? "text-ink-400" : "text-ink-900"
      }`}
    >
      {v}
    </span>
  );
}

function MockTakeoff() {
  return (
    <div className="min-w-[52rem] overflow-hidden rounded-lg border border-line bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-line bg-surface/70 text-left text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-ink-400">
          <tr>
            <th className="px-4 py-2">Item</th>
            <th className="px-2 py-2 text-right">Qty</th>
            <th className="px-2 py-2">Unit</th>
            <th className="px-2 py-2 text-right">Lb/unit</th>
            <th className="px-2 py-2 text-right">Yield %</th>
            <th className="px-2 py-2 text-right">$/lb</th>
            <th className="px-2 py-2 text-right">Net lbs</th>
            <th className="px-2 py-2 text-right">Ordered</th>
            <th className="px-2 py-2 text-right">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          <tr className="bg-brand-50/60">
            <td
              colSpan={9}
              className="px-4 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-brand-700"
            >
              Plating
            </td>
          </tr>
          <tr>
            <td className="px-4 py-1.5">
              <MockCell v={'½" plate 40×10 — deck & bottom shell'} />
            </td>
            <td className="px-2 py-1.5">
              <MockCell v="55" />
            </td>
            <td className="px-2 py-1.5">
              <MockCell v="plates" />
            </td>
            <td className="px-2 py-1.5">
              <MockCell v="8,168" />
            </td>
            <td className="px-2 py-1.5">
              <MockCell v="90" />
            </td>
            <td className="px-2 py-1.5">
              <MockCell v="0.75" />
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
              449,240
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
              499,156
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums">$374,367</td>
          </tr>
          <tr>
            <td
              colSpan={9}
              className="px-4 py-1.5 text-center text-xs text-ink-400"
            >
              … three more plating lines …
            </td>
          </tr>
          <tr className="bg-surface/40 text-xs">
            <td colSpan={6} className="px-4 py-1.5 text-right text-ink-400">
              Subtotal — Plating
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
              579,512
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
              649,623
            </td>
            <td className="px-2 py-1.5 text-right tabular-nums text-ink-600">
              $487,217
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const SENS_GREEN = "#3f7d55";
const SENS_LIGHT = "#8fb573";

function MockSensitivity() {
  const headers = ["$0.66", "$0.72", "$0.78", "$0.84", "$0.90"];
  const rows: {
    hours: string;
    cells: { v: string; c: string; boxed?: boolean }[];
  }[] = [
    {
      hours: "2,450",
      cells: [
        { v: "36%", c: SENS_GREEN },
        { v: "32%", c: SENS_GREEN },
        { v: "28%", c: SENS_GREEN },
        { v: "25%", c: SENS_GREEN },
        { v: "21%", c: SENS_GREEN },
      ],
    },
    {
      hours: "2,975",
      cells: [
        { v: "34%", c: SENS_GREEN },
        { v: "30%", c: SENS_GREEN },
        { v: "27%", c: SENS_GREEN },
        { v: "23%", c: SENS_GREEN },
        { v: "19%", c: SENS_LIGHT },
      ],
    },
    {
      hours: "3,500",
      cells: [
        { v: "33%", c: SENS_GREEN },
        { v: "29%", c: SENS_GREEN },
        { v: "25%", c: SENS_GREEN, boxed: true },
        { v: "21%", c: SENS_GREEN },
        { v: "17%", c: SENS_LIGHT },
      ],
    },
    {
      hours: "4,025",
      cells: [
        { v: "31%", c: SENS_GREEN },
        { v: "27%", c: SENS_GREEN },
        { v: "23%", c: SENS_GREEN },
        { v: "20%", c: SENS_LIGHT },
        { v: "16%", c: SENS_LIGHT },
      ],
    },
    {
      hours: "4,550",
      cells: [
        { v: "29%", c: SENS_GREEN },
        { v: "25%", c: SENS_GREEN },
        { v: "22%", c: SENS_GREEN },
        { v: "18%", c: SENS_LIGHT },
        { v: "14%", c: SENS_LIGHT },
      ],
    },
  ];
  return (
    <div className="min-w-[26rem] rounded-lg border border-line bg-white p-4">
      <table className="w-full text-center text-xs tabular-nums">
        <thead>
          <tr className="text-ink-400">
            <th className="px-2 py-1.5 text-left font-medium">hrs \ $/lb</th>
            {headers.map((h) => (
              <th key={h} className="px-2 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.hours}>
              <th className="px-2 py-1 text-left font-medium text-ink-600">
                {row.hours}
              </th>
              {row.cells.map((cell, i) => (
                <td
                  key={i}
                  className={`px-2 py-1.5 font-medium text-white ${
                    cell.boxed
                      ? "outline outline-2 -outline-offset-2 outline-navy-900"
                      : ""
                  }`}
                  style={{ background: cell.c }}
                >
                  {cell.v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 px-1 text-left text-[0.68rem] text-ink-400">
        &lt; 0% red · 0–10% amber · 10–20% light green · &gt; 20% green
      </p>
    </div>
  );
}

function MockWorkflowCards() {
  return (
    <div className="flex min-w-fit flex-wrap items-start gap-4">
      <div className="w-72 rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
        <p className="mb-2 text-sm font-semibold text-ink-900">
          Submit for approval
        </p>
        <p className="text-xs text-ink-600">
          Submitting locks the takeoff and routes the quote for 3 approvals
          (thresholds are evaluated against the sales price).
        </p>
        <span className={`${buttonCls("dark", "sm")} mt-3`}>
          <Send size={13} strokeWidth={2} />
          Submit quote
        </span>
      </div>
      <div className="w-80 rounded-xl border border-line bg-white p-4 shadow-[0_1px_2px_rgba(13,36,56,0.05)]">
        <p className="mb-2 text-sm font-semibold text-ink-900">
          Approval decision
        </p>
        <p className="mb-2 text-xs text-ink-600">
          1 / 3 approvals granted for v1.
        </p>
        <span className="block w-full rounded-lg border border-line bg-white px-2 py-1.5 text-xs text-ink-400">
          Comment (required to reject / request changes)
        </span>
        <span className="mt-3 flex flex-wrap gap-2">
          <span className={buttonCls("success", "sm")}>
            <Check size={13} strokeWidth={2.5} />
            Approve
          </span>
          <span className={buttonCls("warn", "sm")}>
            <MessageSquareWarning size={13} strokeWidth={2} />
            Request changes
          </span>
          <span className={buttonCls("danger", "sm")}>
            <X size={13} strokeWidth={2.5} />
            Reject
          </span>
        </span>
      </div>
    </div>
  );
}
