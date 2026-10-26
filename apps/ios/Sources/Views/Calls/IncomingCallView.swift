import SwiftUI

// MARK: - IncomingCallView

/// A call ringing this volunteer, shown on the dashboard instead of the in-call card: a
/// ring is not a call in progress, and has no Hang Up / Spam / Ban to offer yet.
///
/// Answer posts to the call's own hub. Where the hub has no in-app leg for this volunteer
/// (the server answers 422) the card says to answer on the phone instead. It never names
/// the caller (A17).
struct IncomingCallView: View {
    let call: ActiveCall
    /// The server refused an in-app answer: only the phone can take this call.
    let answerOnPhone: Bool
    let isAnswering: Bool
    let onAnswer: () async -> Void

    var body: some View {
        BrandCard {
            VStack(spacing: 16) {
                HStack {
                    ZStack {
                        Circle()
                            .fill(Color.green.opacity(0.15))
                            .frame(width: 44, height: 44)
                        Image(systemName: "phone.arrow.down.left.fill")
                            .font(.system(size: 20))
                            .foregroundStyle(Color.green)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text(NSLocalizedString("calls_incoming", comment: "Incoming Call"))
                            .font(.brand(.headline))
                            .foregroundStyle(Color.green)
                        Text(NSLocalizedString("incoming_call_body", comment: "Someone is calling the hotline"))
                            .font(.brand(.caption))
                            .foregroundStyle(Color.brandMutedForeground)
                    }

                    Spacer()
                }

                if answerOnPhone {
                    Text(NSLocalizedString("calls_answer_on_phone", comment: "Answer on your phone"))
                        .font(.brand(.subheadline))
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.brandForeground)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .accessibilityIdentifier("answer-on-phone")
                } else {
                    Button {
                        Task { await onAnswer() }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "phone.fill")
                            Text(NSLocalizedString("calls_answer", comment: "Answer"))
                                .fontWeight(.semibold)
                        }
                        .font(.brand(.subheadline))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.green, in: RoundedRectangle(cornerRadius: 8))
                    }
                    .disabled(isAnswering)
                    .opacity(isAnswering ? 0.6 : 1.0)
                    .accessibilityIdentifier("answer-call-button")
                }
            }
            .padding(16)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.green.opacity(0.6), lineWidth: 2)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("incoming-call-card")
    }
}

// MARK: - EndedCallView

/// Shown in place of the call card when this volunteer's own call ends: the moment to
/// write down what happened. Holds nothing but what it is given; the dashboard keeps the
/// call id in memory until the prompt is dismissed or the note is saved.
struct EndedCallView: View {
    let onAddNote: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        BrandCard {
            VStack(spacing: 12) {
                HStack {
                    Image(systemName: "phone.down.fill")
                        .foregroundStyle(Color.brandMutedForeground)
                    Text(NSLocalizedString("calls_ended", comment: "Call Ended"))
                        .font(.brand(.headline))
                        .foregroundStyle(Color.brandForeground)
                    Spacer()
                    Button(action: onDismiss) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Color.brandMutedForeground)
                    }
                    .accessibilityLabel(NSLocalizedString("common_dismiss", comment: "Dismiss"))
                    .accessibilityIdentifier("ended-call-dismiss")
                }

                Button(action: onAddNote) {
                    HStack(spacing: 6) {
                        Image(systemName: "note.text.badge.plus")
                        Text(NSLocalizedString("calls_add_note", comment: "Add Note"))
                            .fontWeight(.medium)
                    }
                    .font(.brand(.subheadline))
                    .foregroundStyle(Color.brandPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.brandPrimary.opacity(0.08))
                    )
                }
                .accessibilityIdentifier("ended-call-add-note")
            }
            .padding(16)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ended-call-card")
    }
}
