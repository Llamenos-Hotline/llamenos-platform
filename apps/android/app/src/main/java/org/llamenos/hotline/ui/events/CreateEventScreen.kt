package org.llamenos.hotline.ui.events

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R

/**
 * Screen for creating a new event record.
 *
 * Provides a form with title, description, location, and date fields.
 * The event is created as a CMS record under the first event entity type.
 *
 * The title and description are sealed on this device by
 * [EventsViewModel.createEvent]; the server never receives them as plaintext.
 *
 * @param viewModel Shared EventsViewModel for state access
 * @param onNavigateBack Callback to navigate back
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CreateEventScreen(
    viewModel: EventsViewModel,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()

    var title by rememberSaveable { mutableStateOf("") }
    var description by rememberSaveable { mutableStateOf("") }
    var location by rememberSaveable { mutableStateOf("") }

    val eventEntityTypes = uiState.eventEntityTypes
    val defaultEntityType = eventEntityTypes.firstOrNull()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.events_new_event),
                        modifier = Modifier.testTag("create-event-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = onNavigateBack,
                        modifier = Modifier.testTag("create-event-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ),
            )
        },
        modifier = modifier,
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Entity type indicator
            if (defaultEntityType != null) {
                Text(
                    text = stringResource(R.string.events_creating_as, defaultEntityType.label),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("create-event-type"),
                )
            }

            // Title
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text(stringResource(R.string.events_field_title)) },
                placeholder = { Text(stringResource(R.string.events_field_title_placeholder)) },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("create-event-title-field"),
            )

            // Description
            OutlinedTextField(
                value = description,
                onValueChange = { description = it },
                label = { Text(stringResource(R.string.events_field_description)) },
                placeholder = { Text(stringResource(R.string.events_field_description_placeholder)) },
                minLines = 3,
                maxLines = 6,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("create-event-description-field"),
            )

            // Location
            OutlinedTextField(
                value = location,
                onValueChange = { location = it },
                label = { Text(stringResource(R.string.events_field_location)) },
                placeholder = { Text(stringResource(R.string.events_field_location_placeholder)) },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("create-event-location-field"),
            )

            // Info text about encryption
            Text(
                text = stringResource(R.string.events_create_info),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            )

            // Error
            if (uiState.actionError != null) {
                Text(
                    text = uiState.actionError ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.testTag("create-event-error"),
                )
            }

            Spacer(Modifier.height(8.dp))

            // Submit button
            // Note: Actual creation requires routing through the CaseManagementViewModel
            // which handles E2EE encryption. This screen provides the form UI.
            Button(
                onClick = {
                    defaultEntityType?.let { et ->
                        viewModel.createEvent(et.id, title, description) {
                            onNavigateBack()
                        }
                    }
                },
                enabled = title.isNotBlank() && defaultEntityType != null,
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("create-event-submit"),
            ) {
                Text(stringResource(R.string.events_new_event))
            }
        }
    }
}
