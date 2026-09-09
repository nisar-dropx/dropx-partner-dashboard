# OpsPulse Unplanned Leaves

The OpsPulse attendance page is a read-only view of People’s unplanned-leave case register. It uses the same Not punched / Updated grouping, today/earlier/punched summary, date range and backlog controls, and Person / Location / Day & shift / Attendance / Follow-up columns. Existing follow-up reasons are visible; editing and private HR notes are not exposed.

Case detection and follow-up remain owned by People. Opening OpsPulse never creates cases, changes statuses, writes reasons, approves attendance or sends notifications. A stable service-only database projection reads current punch evidence and approved leave without mutating the case register. Older dates display the cases already detected in People.

Access is determined by the verified OpsPulse authorization context: company plus all-location access or explicit allowed location IDs. It does not depend on a reporting-manager hierarchy. Both rows and location options are scoped before returning data; the server also checks the returned scope. Empty location scope yields no rows. Page permission and Ops product membership remain required. The page and Excel export use the same filter/grouping function; exports include all matching rows, independent of pagination.

The page defaults to today with earlier open cases included. Date ranges are limited to 31 days. Updated cases are shown only inside the selected range. Refresh runs every minute while the tab is visible and online. Legacy `date` links remain valid.

The screen shows concise counts, filters and leave details. Grace-period configuration, refresh intervals and repetitive process explanations are omitted from the display; attendance detection rules are unchanged.

Validation: `node scripts/verify-ops-unplanned-leaves.mjs`, repository prebuild checks, TypeScript and production build. Live database checks cover all locations, one location, empty scope, a non-owner location account, omission of private HR notes, and denial of direct anon/authenticated function execution.
