import SwiftUI

// MARK: - HelpView

/// Help screen with security overview, role-based guides, and FAQ sections.
/// Static/presentational — no API calls needed.
struct HelpView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        List {
            securityOverviewSection
            volunteerGuideSection
            if appState.hasPermission("settings:read") {
                adminGuideSection
            }
            faqGettingStartedSection
            faqCallsSection
            faqNotesSection
            if appState.hasPermission("settings:read") {
                faqAdminSection
            }
            footerSection
        }
        .navigationTitle(NSLocalizedString("help_title", comment: "Help"))
        .navigationBarTitleDisplayMode(.large)
        .accessibilityIdentifier("help-screen")
    }

    // MARK: - Security Overview

    private var securityOverviewSection: some View {
        Section {
            securityRow(
                icon: "lock.fill",
                color: Color.statusActive,
                title: NSLocalizedString("help_security_notes", comment: "Notes"),
                detail: NSLocalizedString("help_security_notes_detail", comment: "End-to-end encrypted")
            )
            securityRow(
                icon: "lock.fill",
                color: Color.statusActive,
                title: NSLocalizedString("help_security_reports", comment: "Reports"),
                detail: NSLocalizedString("help_security_reports_detail", comment: "End-to-end encrypted")
            )
            securityRow(
                icon: "key.fill",
                color: Color.brandPrimary,
                title: NSLocalizedString("help_security_auth", comment: "Authentication"),
                detail: NSLocalizedString("help_security_auth_detail", comment: "Nostr keypair + WebAuthn")
            )
            securityRow(
                icon: "shield.fill",
                color: Color.brandDarkTeal,
                title: NSLocalizedString("help_security_sessions", comment: "Sessions"),
                detail: NSLocalizedString("help_security_sessions_detail", comment: "Encrypted device tokens")
            )
        } header: {
            Label {
                Text(NSLocalizedString("help_security_header", comment: "Security Overview"))
            } icon: {
                Image(systemName: "shield.lefthalf.filled")
                    .foregroundStyle(Color.brandPrimary)
            }
            .font(.brand(.headline))
        }
        .accessibilityIdentifier("help-security-section")
    }

    @ViewBuilder
    private func securityRow(icon: String, color: Color, title: String, detail: String) -> some View {
        LabeledContent {
            Text(detail)
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
        } label: {
            Label {
                Text(title)
            } icon: {
                Image(systemName: icon)
                    .foregroundStyle(color)
            }
        }
    }

    // MARK: - Volunteer Guide

    private var volunteerGuideSection: some View {
        Section {
            guideItem(
                title: NSLocalizedString("help_vol_calls_title", comment: "How calls work"),
                detail: NSLocalizedString("help_vol_calls_detail", comment: "When a caller dials the hotline, all on-shift volunteers ring simultaneously. The first volunteer to pick up handles the call — all other rings are cancelled. Calls are routed based on your shift schedule and availability.")
            )
            guideItem(
                title: NSLocalizedString("help_vol_shift_title", comment: "Managing your shift"),
                detail: NSLocalizedString("help_vol_shift_detail", comment: "Clock in when your shift starts to begin receiving calls. Use break mode when you need a pause — you'll stop receiving calls but stay logged in. Clock out at the end of your shift.")
            )
            guideItem(
                title: NSLocalizedString("help_vol_notes_title", comment: "Taking notes"),
                detail: NSLocalizedString("help_vol_notes_detail", comment: "Create notes during or after calls to document interactions. Notes support custom fields defined by your admin. All note content is end-to-end encrypted — only you and admins can read them.")
            )
            guideItem(
                title: NSLocalizedString("help_vol_encryption_title", comment: "Encryption basics"),
                detail: NSLocalizedString("help_vol_encryption_detail", comment: "Your device signing key never leaves your device. Notes and messages are encrypted locally before being sent to the server. Even if the server is compromised, your data remains private.")
            )
            guideItem(
                title: NSLocalizedString("help_vol_safety_title", comment: "Staying safe"),
                detail: NSLocalizedString("help_vol_safety_detail", comment: "Lock the app when stepping away. Use PIN protection to prevent unauthorized access. If you're in a dangerous situation, use Emergency Wipe in Settings to permanently delete all app data from this device.")
            )
        } header: {
            Label {
                Text(NSLocalizedString("help_volunteer_guide_header", comment: "Volunteer Guide"))
            } icon: {
                Image(systemName: "person.fill")
                    .foregroundStyle(Color.brandPrimary)
            }
            .font(.brand(.headline))
        }
        .accessibilityIdentifier("help-volunteer-guide")
    }

    // MARK: - Admin Guide

    private var adminGuideSection: some View {
        Section {
            guideItem(
                title: NSLocalizedString("help_admin_volunteers_title", comment: "Managing volunteers"),
                detail: NSLocalizedString("help_admin_volunteers_detail", comment: "Invite new volunteers with invite codes. Assign roles, manage permissions, and deactivate accounts as needed. Volunteer personal information is only visible to admins.")
            )
            guideItem(
                title: NSLocalizedString("help_admin_shifts_title", comment: "Shift scheduling"),
                detail: NSLocalizedString("help_admin_shifts_detail", comment: "Set up recurring shift schedules with ring groups. Configure fallback groups for when no scheduled shift is active. Volunteers can only receive calls when clocked into their shift.")
            )
            guideItem(
                title: NSLocalizedString("help_admin_audit_title", comment: "Audit logs"),
                detail: NSLocalizedString("help_admin_audit_detail", comment: "Every action is logged in a tamper-evident chain. View who answered calls, created notes, and made changes. The hash chain ensures logs cannot be modified after the fact.")
            )
            guideItem(
                title: NSLocalizedString("help_admin_spam_title", comment: "Spam mitigation"),
                detail: NSLocalizedString("help_admin_spam_detail", comment: "Enable voice CAPTCHA to filter automated calls. Configure rate limiting per caller. Manage ban lists to block known bad actors. All settings can be adjusted in real-time.")
            )
            guideItem(
                title: NSLocalizedString("help_admin_reports_title", comment: "Reports & contacts"),
                detail: NSLocalizedString("help_admin_reports_detail", comment: "Review incident reports filed by volunteers. View contact timelines showing all interactions with a caller. Caller identifiers are HMAC-hashed for privacy.")
            )
        } header: {
            Label {
                Text(NSLocalizedString("help_admin_guide_header", comment: "Admin Guide"))
            } icon: {
                Image(systemName: "shield.fill")
                    .foregroundStyle(Color.brandPrimary)
            }
            .font(.brand(.headline))
        }
        .accessibilityIdentifier("help-admin-guide")
    }

    // MARK: - FAQ Sections

    private var faqGettingStartedSection: some View {
        Section {
            faqItem(
                question: NSLocalizedString("help_faq_gs_q1", comment: "How do I get started?"),
                answer: NSLocalizedString("help_faq_gs_a1", comment: "Ask your admin for an invite code. Enter the hub URL, create or import your identity, and set a PIN. You'll be ready to receive calls once you clock in for your shift.")
            )
            faqItem(
                question: NSLocalizedString("help_faq_gs_q2", comment: "What is a device key?"),
                answer: NSLocalizedString("help_faq_gs_a2", comment: "Your device key is your secret signing key — like a password that proves your identity. It's generated on your device and never sent to the server. Back it up securely; if you lose it, you'll need a new identity.")
            )
            faqItem(
                question: NSLocalizedString("help_faq_gs_q3", comment: "Can I use multiple devices?"),
                answer: NSLocalizedString("help_faq_gs_a3", comment: "Not yet. This release supports one device per identity — multi-device linking is planned for a future update. For now, sign in on the device where you created your identity.")
            )
        } header: {
            Label {
                Text(NSLocalizedString("help_faq_getting_started_header", comment: "FAQ: Getting Started"))
            } icon: {
                Image(systemName: "questionmark.circle.fill")
                    .foregroundStyle(Color.brandPrimary)
            }
            .font(.brand(.headline))
        }
        .accessibilityIdentifier("help-faq-section")
    }

    private var faqCallsSection: some View {
        Section {
            faqItem(
                question: NSLocalizedString("help_faq_calls_q1", comment: "Why am I not receiving calls?"),
                answer: NSLocalizedString("help_faq_calls_a1", comment: "Make sure you are clocked in for your shift and not on break. Check that your internet connection is stable (the relay connection indicator should be green).")
            )
            faqItem(
                question: NSLocalizedString("help_faq_calls_q2", comment: "What happens if I miss a call?"),
                answer: NSLocalizedString("help_faq_calls_a2", comment: "If you don't answer, the call continues ringing for other on-shift volunteers. The first volunteer to pick up handles the call. Missed calls are logged in the dashboard.")
            )
        } header: {
            Label {
                Text(NSLocalizedString("help_faq_calls_header", comment: "FAQ: Calls"))
            } icon: {
                Image(systemName: "phone.fill")
                    .foregroundStyle(Color.brandPrimary)
            }
            .font(.brand(.headline))
        }
    }

    private var faqNotesSection: some View {
        Section {
            faqItem(
                question: NSLocalizedString("help_faq_notes_q1", comment: "Are my notes private?"),
                answer: NSLocalizedString("help_faq_notes_a1", comment: "Yes. Notes are end-to-end encrypted with a unique key per note. Only you and your admins can decrypt them. The server never sees the plaintext content.")
            )
            faqItem(
                question: NSLocalizedString("help_faq_notes_q2", comment: "Can I edit a note after saving?"),
                answer: NSLocalizedString("help_faq_notes_a2", comment: "Notes are append-only for security. You can add additional notes but cannot modify existing ones. This ensures a reliable audit trail.")
            )
        } header: {
            Label {
                Text(NSLocalizedString("help_faq_notes_header", comment: "FAQ: Notes"))
            } icon: {
                Image(systemName: "note.text")
                    .foregroundStyle(Color.brandPrimary)
            }
            .font(.brand(.headline))
        }
    }

    private var faqAdminSection: some View {
        Section {
            faqItem(
                question: NSLocalizedString("help_faq_admin_q1", comment: "How do I add a new volunteer?"),
                answer: NSLocalizedString("help_faq_admin_a1", comment: "Go to Admin Panel > Invites and create a new invite code. Share the code securely with the volunteer. They'll use it during onboarding to register with your hub.")
            )
            faqItem(
                question: NSLocalizedString("help_faq_admin_q2", comment: "How do I ban a caller?"),
                answer: NSLocalizedString("help_faq_admin_a2", comment: "Go to Admin Panel > Ban List and add the caller's phone number. Banned callers will hear a message and be disconnected automatically.")
            )
            faqItem(
                question: NSLocalizedString("help_faq_admin_q3", comment: "Can I see all volunteer activity?"),
                answer: NSLocalizedString("help_faq_admin_a3", comment: "Yes. The Audit Log in the Admin Panel shows all actions: calls answered, notes created, shifts started/ended, and more. The log is tamper-evident with hash chaining.")
            )
        } header: {
            Label {
                Text(NSLocalizedString("help_faq_admin_header", comment: "FAQ: Admin"))
            } icon: {
                Image(systemName: "gearshape.fill")
                    .foregroundStyle(Color.brandPrimary)
            }
            .font(.brand(.headline))
        }
    }

    // MARK: - Footer

    private var footerSection: some View {
        Section {
            // Empty section just for footer
        } footer: {
            VStack(spacing: 4) {
                Text(appVersion)
                    .font(.brand(.caption))
                    .foregroundStyle(.tertiary)
                Text(NSLocalizedString("settings_footer", comment: "Llamenos - Secure Crisis Response"))
                    .font(.brand(.caption2))
                    .foregroundStyle(.quaternary)
            }
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 8)
        }
    }

    // MARK: - Reusable Components

    @ViewBuilder
    private func guideItem(title: String, detail: String) -> some View {
        DisclosureGroup {
            Text(detail)
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
                .padding(.vertical, 4)
        } label: {
            Text(title)
                .font(.brand(.body))
                .foregroundStyle(Color.brandForeground)
        }
    }

    @ViewBuilder
    private func faqItem(question: String, answer: String) -> some View {
        DisclosureGroup {
            Text(answer)
                .font(.brand(.subheadline))
                .foregroundStyle(Color.brandMutedForeground)
                .padding(.vertical, 4)
        } label: {
            Text(question)
                .font(.brand(.body))
                .foregroundStyle(Color.brandForeground)
        }
    }

    // MARK: - Helpers

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Help") {
    NavigationStack {
        HelpView()
            .environment(AppState(hubContext: HubContext()))
    }
}
#endif
