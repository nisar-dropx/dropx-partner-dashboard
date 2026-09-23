import type { Metadata } from "next";
import Image from "next/image";
import { MapPin, Camera, Bell, ShieldCheck, Mail } from "lucide-react";

export const metadata: Metadata = {
  title: {
    absolute: "Privacy Policy | DropX One"
  },
  description:
    "How DropX One collects, uses, and protects location, camera, and attendance data for employees, field executives, and contractors."
};

const contactEmail = "mailto:nisar@dropxlogistics.com?subject=DropX%20One%20privacy%20question";

export default function PrivacyPolicyPage() {
  return (
    <main className="deletion-page">
      <header className="deletion-header">
        <Image
          alt="DropX"
          className="deletion-logo"
          height={62}
          priority
          src="/dropx-logo.png"
          width={176}
        />
        <span>DropX One</span>
      </header>

      <article className="deletion-content">
        <div className="deletion-title">
          <div className="deletion-title-icon" aria-hidden="true">
            <ShieldCheck size={24} strokeWidth={1.8} />
          </div>
          <div>
            <p className="deletion-eyebrow">Privacy Policy</p>
            <h1>DropX One Privacy Policy</h1>
            <p>
              This policy applies to employees, field executives, and
              independent contractors who use the DropX One app for
              attendance, dispatch, and workforce management. Last updated 23
              September 2026.
            </p>
          </div>
        </div>

        <section className="deletion-section">
          <h2>Who this app is for</h2>
          <p>
            DropX One is a workforce app provided by your employer or
            engaging company (a DropX Logistics customer) for attendance
            tracking, shift roster management, and related HR functions. It
            is not available to the general public — access requires an
            active employment or contractor relationship with a company
            using DropX Logistics&rsquo; systems.
          </p>
        </section>

        <section className="deletion-grid">
          <div className="deletion-info">
            <MapPin size={20} aria-hidden="true" />
            <div>
              <h2>Location, including in the background</h2>
              <p>
                While you are clocked in for a shift, DropX One records your
                device&rsquo;s GPS location — including while the app is
                closed or the screen is off — so your employer can verify you
                are at your assigned station, confirm attendance, and support
                dispatch decisions. This requires &ldquo;Allow all the
                time&rdquo; location permission; the app explains this and
                asks for your consent before requesting it, and location
                collection stops as soon as you punch out. Location data is
                also used to detect and flag signals of GPS spoofing
                (&ldquo;fake GPS&rdquo; apps) or location/internet being
                turned off during a shift, which may affect attendance
                calculation under your employer&rsquo;s policies.
              </p>
            </div>
          </div>

          <div className="deletion-info">
            <Camera size={20} aria-hidden="true" />
            <div>
              <h2>Camera</h2>
              <p>
                DropX One uses your device camera to capture a live selfie at
                punch-in/punch-out, matched against your profile photo to
                confirm the person punching in is actually you. Selfies are
                captured only when you actively submit a punch and are not
                accessed at any other time.
              </p>
            </div>
          </div>

          <div className="deletion-info">
            <Bell size={20} aria-hidden="true" />
            <div>
              <h2>Notifications</h2>
              <p>
                DropX One sends push notifications for punch confirmations,
                approvals, and account activity, using a device token
                registered with Firebase Cloud Messaging. On some devices,
                the app may request &ldquo;Notification access&rdquo; so it
                can add a &ldquo;Mark as read&rdquo; action directly to a
                notification; this access is used only to manage DropX
                One&rsquo;s own notifications and never reads notifications
                from other apps.
              </p>
            </div>
          </div>

          <div className="deletion-info">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <h2>Attendance and device signals</h2>
              <p>
                Punch times, GPS coordinates, station/geofence status, and
                device integrity signals (developer mode, USB debugging, mock
                location, VPN use) are recorded against your employee/
                contractor profile to calculate attendance and detect
                policy-relevant anomalies for your employer&rsquo;s review.
              </p>
            </div>
          </div>
        </section>

        <section className="deletion-section">
          <h2>Who this data is shared with</h2>
          <p>
            Data collected by DropX One is shared with the company you work
            for or are contracted to, for attendance, payroll, and workforce
            management purposes. It is not sold to third parties or used for
            advertising. Service providers (cloud hosting, push notification
            delivery) may process data on DropX Logistics&rsquo; behalf under
            contractual confidentiality obligations.
          </p>
        </section>

        <section className="deletion-section">
          <h2>How long data is kept</h2>
          <p>
            Attendance, location, and punch records are retained for as long
            as required for payroll, statutory, tax, audit, or fraud
            prevention purposes under applicable law, or for the duration of
            your engagement plus any legally required retention period.
            Selfie images are retained only as long as needed to support a
            specific punch verification or an active review of that punch.
          </p>
        </section>

        <section className="deletion-section deletion-timeline">
          <h2>Your choices and rights</h2>
          <p>
            You can revoke location, camera, or notification permissions at
            any time from your device Settings, though this will prevent
            DropX One&rsquo;s attendance features from working correctly. To
            request deletion of your account and associated personal data,
            visit our{" "}
            <a href="/account-deletion">account deletion page</a>. For any
            other privacy question or request, contact us using the details
            below.
          </p>
        </section>

        <section className="deletion-section">
          <h2>Contact us</h2>
          <a className="deletion-button" href={contactEmail}>
            <Mail size={18} aria-hidden="true" />
            Contact DropX Logistics
          </a>
          <p className="deletion-contact">
            Privacy questions are handled by{" "}
            <a href="mailto:nisar@dropxlogistics.com">
              nisar@dropxlogistics.com
            </a>
            .
          </p>
        </section>
      </article>

      <footer className="deletion-footer">
        DropX Logistics · DropX One · Privacy Policy
      </footer>
    </main>
  );
}
