import SwiftUI

struct A2pRegistrationView: View {
    let service: MessagingConfigService

    @State private var showBrandForm = false
    @State private var showCampaignForm = false
    @State private var submitting = false

    @State private var entityType = "NON_PROFIT"
    @State private var companyName = ""
    @State private var ein = ""
    @State private var phone = ""
    @State private var email = ""
    @State private var street = ""
    @State private var city = ""
    @State private var state = ""
    @State private var postalCode = ""
    @State private var country = "US"

    @State private var useCase = "PUBLIC_SERVICE_ANNOUNCEMENT"
    @State private var campaignDescription = ""
    @State private var helpMessage = ""
    @State private var optinMessage = ""
    @State private var optoutMessage = ""
    @State private var sampleMessage1 = ""
    @State private var sampleMessage2 = ""

    var body: some View {
        let brandStatus = service.a2pRegistration?.brandStatus ?? .notSubmitted
        let campaignStatus = service.a2pRegistration?.campaignStatus ?? .notSubmitted
        let isApproved = brandStatus == .approved && campaignStatus == .approved
        let isSkipped = brandStatus == .skipped

        Section(header: Text(NSLocalizedString("channels_a2p_title", comment: "A2P 10DLC Registration"))) {
            Text(NSLocalizedString("channels_a2p_description", comment: ""))
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack {
                Text(NSLocalizedString("channels_a2p_brand_status", comment: "Brand"))
                Spacer()
                Text(brandStatus.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                    .foregroundStyle(brandStatus == .approved ? .green : brandStatus == .failed ? .red : .secondary)
            }

            HStack {
                Text(NSLocalizedString("channels_a2p_campaign_status", comment: "Campaign"))
                Spacer()
                Text(campaignStatus.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                    .foregroundStyle(campaignStatus == .approved ? .green : campaignStatus == .failed ? .red : .secondary)
            }

            if brandStatus == .notSubmitted || brandStatus == .failed {
                Button(brandStatus == .failed
                    ? NSLocalizedString("channels_a2p_resubmit_brand", comment: "Re-submit Brand")
                    : NSLocalizedString("channels_a2p_submit_brand", comment: "Register Brand")) {
                    showBrandForm = true
                }
                .accessibilityIdentifier("a2p-start-brand")

                Button(NSLocalizedString("channels_a2p_skip", comment: "Skip A2P")) {
                    Task {
                        submitting = true
                        _ = try? await service.skipA2p(hubId: service.config?.enabledChannels.first ?? "")
                        submitting = false
                    }
                }
                .foregroundStyle(.secondary)
            }

            if brandStatus == "approved" && (campaignStatus == "not_submitted" || campaignStatus == "failed") {
                Button(campaignStatus == "failed"
                    ? NSLocalizedString("channels_a2p_resubmit_campaign", comment: "Re-submit Campaign")
                    : NSLocalizedString("channels_a2p_submit_campaign", comment: "Register Campaign")) {
                    showCampaignForm = true
                }
                .accessibilityIdentifier("a2p-start-campaign")
            }

            if isApproved {
                Label(NSLocalizedString("channels_a2p_approved_message", comment: "Approved"), systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            }
        }
        .sheet(isPresented: $showBrandForm) { brandFormSheet }
        .sheet(isPresented: $showCampaignForm) { campaignFormSheet }
    }

    private var brandFormSheet: some View {
        NavigationStack {
            Form {
                Section(header: Text(NSLocalizedString("channels_a2p_brand_form_title", comment: "Brand Registration"))) {
                    Picker(NSLocalizedString("channels_a2p_entity_type", comment: "Entity Type"), selection: $entityType) {
                        Text(NSLocalizedString("channels_a2p_entity_types_non_profit", comment: "Non-profit")).tag("NON_PROFIT")
                        Text(NSLocalizedString("channels_a2p_entity_types_private_profit", comment: "Private")).tag("PRIVATE_PROFIT")
                        Text(NSLocalizedString("channels_a2p_entity_types_public_profit", comment: "Public")).tag("PUBLIC_PROFIT")
                        Text(NSLocalizedString("channels_a2p_entity_types_government", comment: "Government")).tag("GOVERNMENT")
                    }
                    TextField(NSLocalizedString("channels_a2p_company_name", comment: "Company Name"), text: $companyName)
                        .accessibilityIdentifier("a2p-company-name")
                    TextField(NSLocalizedString("channels_a2p_ein", comment: "EIN"), text: $ein)
                        .accessibilityIdentifier("a2p-ein")
                    TextField(NSLocalizedString("channels_a2p_phone", comment: "Phone"), text: $phone)
                    TextField(NSLocalizedString("channels_a2p_email", comment: "Email"), text: $email)
                }

                Section(header: Text(NSLocalizedString("channels_a2p_address", comment: "Address"))) {
                    TextField(NSLocalizedString("channels_a2p_street", comment: "Street"), text: $street)
                    TextField(NSLocalizedString("channels_a2p_city", comment: "City"), text: $city)
                    TextField(NSLocalizedString("channels_a2p_state", comment: "State"), text: $state)
                    TextField(NSLocalizedString("channels_a2p_postal_code", comment: "Postal Code"), text: $postalCode)
                    TextField(NSLocalizedString("channels_a2p_country", comment: "Country"), text: $country)
                }
            }
            .navigationTitle(NSLocalizedString("channels_a2p_brand_form_title", comment: "Brand Registration"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) { showBrandForm = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("channels_a2p_submit_brand", comment: "Submit")) {
                        Task { await submitBrand() }
                    }
                    .disabled(submitting || companyName.isEmpty || ein.isEmpty)
                    .accessibilityIdentifier("a2p-submit-brand")
                }
            }
        }
    }

    private var campaignFormSheet: some View {
        NavigationStack {
            Form {
                Section(header: Text(NSLocalizedString("channels_a2p_campaign_form_title", comment: "Campaign Registration"))) {
                    TextField(NSLocalizedString("channels_a2p_campaign_description", comment: "Description"), text: $campaignDescription)
                        .accessibilityIdentifier("a2p-campaign-desc")
                    TextField(NSLocalizedString("channels_a2p_help_message", comment: "Help Message"), text: $helpMessage)
                    TextField(NSLocalizedString("channels_a2p_optin_message", comment: "Opt-in Message"), text: $optinMessage)
                    TextField(NSLocalizedString("channels_a2p_optout_message", comment: "Opt-out Message"), text: $optoutMessage)
                    TextField(NSLocalizedString("channels_a2p_sample_messages", comment: "Sample 1"), text: $sampleMessage1)
                    TextField(NSLocalizedString("channels_a2p_sample_messages", comment: "Sample 2"), text: $sampleMessage2)
                }
            }
            .navigationTitle(NSLocalizedString("channels_a2p_campaign_form_title", comment: "Campaign Registration"))
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(NSLocalizedString("common_cancel", comment: "Cancel")) { showCampaignForm = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(NSLocalizedString("channels_a2p_submit_campaign", comment: "Submit")) {
                        Task { await submitCampaign() }
                    }
                    .disabled(submitting || campaignDescription.isEmpty)
                    .accessibilityIdentifier("a2p-submit-campaign")
                }
            }
        }
    }

    private func submitBrand() async {
        submitting = true
        let brandInfo: [String: Any] = [
            "entityType": entityType,
            "companyName": companyName,
            "ein": ein,
            "phone": phone,
            "email": email,
            "street": street,
            "city": city,
            "state": state,
            "postalCode": postalCode,
            "country": country,
        ]
        do {
            let result = try await service.submitBrand(hubId: service.a2pRegistration?.hubID ?? "", brandInfo: brandInfo)
            service.a2pRegistration = result
            showBrandForm = false
        } catch {
        }
        submitting = false
    }

    private func submitCampaign() async {
        guard let regId = service.a2pRegistration?.id else { return }
        submitting = true
        let campaignInfo: [String: Any] = [
            "useCase": useCase,
            "description": campaignDescription,
            "helpMessage": helpMessage,
            "optinMessage": optinMessage,
            "optoutMessage": optoutMessage,
            "sampleMessages": [sampleMessage1, sampleMessage2].filter { !$0.isEmpty },
            "subscriberOptin": true,
            "subscriberOptout": true,
            "subscriberHelp": true,
        ]
        do {
            let result = try await service.submitCampaign(
                registrationId: regId,
                hubId: service.a2pRegistration?.hubID ?? "",
                campaignInfo: campaignInfo
            )
            service.a2pRegistration = result
            showCampaignForm = false
        } catch {
        }
        submitting = false
    }
}
