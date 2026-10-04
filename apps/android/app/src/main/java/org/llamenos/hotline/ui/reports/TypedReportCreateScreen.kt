package org.llamenos.hotline.ui.reports

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CalendarToday
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.JoinFieldType
import org.llamenos.hotline.model.LocationResult
import org.llamenos.hotline.model.ReportTypeDefinitionField
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Template-driven report creation screen.
 *
 * Renders a dynamic Compose form based on the selected [ReportTypeDefinition]'s
 * field list. Each field type maps to an appropriate Material 3 widget:
 * - `text` -> OutlinedTextField (single line)
 * - `textarea` -> OutlinedTextField (multi-line, optional audio input)
 * - `number` -> OutlinedTextField with numeric keyboard
 * - `select` -> ExposedDropdownMenuBox
 * - `multiselect` -> FlowRow of FilterChips
 * - `checkbox` -> Checkbox with label
 * - `date` -> DatePickerDialog trigger
 *
 * Required fields are marked with an asterisk. The submit button is disabled
 * until all required fields are filled.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TypedReportCreateScreen(
    viewModel: ReportsViewModel,
    reportTypeId: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    val reportType = uiState.reportTypes.find { it.id == reportTypeId }

    // Local form state: title + per-field values
    var title by remember { mutableStateOf("") }
    var fieldValues by remember { mutableStateOf<Map<String, String>>(emptyMap()) }

    // Sync selected report type on entry
    LaunchedEffect(reportTypeId) {
        val rt = uiState.reportTypes.find { it.id == reportTypeId }
        if (rt != null) {
            viewModel.selectReportType(rt)
        }
    }

    // Navigate back on successful creation
    LaunchedEffect(uiState.createSuccess) {
        if (uiState.createSuccess) {
            viewModel.clearCreateSuccess()
            onNavigateBack()
        }
    }

    // Compute whether all required fields are filled.
    // File fields are excluded from this check: mobile file uploads are not
    // implemented yet (see the JoinFieldType.File branch in DynamicField below),
    // so a report type that marks a file field required would otherwise be
    // permanently unsubmittable from Android.
    val allRequiredFilled = remember(fieldValues, title, reportType) {
        if (reportType == null) false
        else {
            title.isNotBlank() && reportType.fields
                .filter { it.required && it.type != JoinFieldType.File }
                .all { field ->
                    val value = fieldValues[field.name]
                    !value.isNullOrBlank()
                }
        }
    }

    val screenTitle = if (reportType != null) {
        stringResource(R.string.report_typed_create_title, reportType.label)
    } else {
        stringResource(R.string.report_type_picker_title)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = screenTitle,
                        modifier = Modifier.testTag("typed-report-create-title"),
                    )
                },
                navigationIcon = {
                    IconButton(
                        onClick = {
                            viewModel.clearReportType()
                            onNavigateBack()
                        },
                        modifier = Modifier.testTag("typed-report-create-back"),
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.reports_back),
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        modifier = modifier,
    ) { paddingValues ->
        if (reportType == null) {
            // Report type not found — shouldn't happen in normal flow
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(R.string.reports_not_found),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("typed-report-not-found"),
                )
            }
        } else {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
                    .verticalScroll(rememberScrollState())
                    .padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // Report type description
                if (reportType.description.isNotBlank()) {
                    Text(
                        text = reportType.description,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("typed-report-description"),
                    )
                }

                // Title field (always present)
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    label = {
                        Text(
                            buildString {
                                append(stringResource(R.string.report_typed_title_label))
                                append(" ")
                                append(stringResource(R.string.report_typed_required))
                            },
                        )
                    },
                    placeholder = { Text(stringResource(R.string.report_typed_title_placeholder)) },
                    singleLine = true,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("typed-report-title-input"),
                )

                // Dynamic fields grouped by section
                val sortedFields = reportType.fields.sortedBy { it.order }
                var currentSection: String? = null

                sortedFields.forEach { field ->
                    // Section header if the section changed
                    if (field.section != null && field.section != currentSection) {
                        currentSection = field.section
                        Spacer(Modifier.height(8.dp))
                        HorizontalDivider()
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = field.section,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag("typed-report-section-${field.section}"),
                        )
                    }

                    DynamicField(
                        field = field,
                        value = fieldValues[field.name] ?: "",
                        onValueChange = { newValue ->
                            fieldValues = fieldValues + (field.name to newValue)
                        },
                        onSearchLocation = viewModel::searchLocations,
                    )
                }

                // Error message
                if (uiState.actionError != null) {
                    Text(
                        text = uiState.actionError ?: "",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.testTag("typed-report-create-error"),
                    )
                }

                // Submit button
                Button(
                    onClick = {
                        viewModel.createTypedReport(
                            reportTypeId = reportTypeId,
                            title = title.trim(),
                            fieldValues = fieldValues.mapValues { (_, v) -> v.trim() },
                        )
                    },
                    enabled = allRequiredFilled && !uiState.isCreating,
                    modifier = Modifier
                        .fillMaxWidth()
                        .testTag("typed-report-submit-button"),
                ) {
                    if (uiState.isCreating) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                        Spacer(Modifier.width(8.dp))
                    }
                    Text(stringResource(R.string.report_typed_submit))
                }
            }
        }
    }
}

/**
 * Renders a single dynamic field based on its type definition.
 *
 * Uses the protocol-generated [ReportTypeDefinitionField] with its enum-typed
 * [ReportFieldDefinitionType] for exhaustive matching.
 */
@Composable
private fun DynamicField(
    field: ReportTypeDefinitionField,
    value: String,
    onValueChange: (String) -> Unit,
    onSearchLocation: suspend (String) -> List<LocationResult>,
    modifier: Modifier = Modifier,
) {
    val labelText = buildString {
        append(field.label)
        if (field.required) {
            append(" ")
            append("*")
        }
    }

    Column(modifier = modifier.fillMaxWidth()) {
        when (field.type) {
            JoinFieldType.Text -> TextInputField(
                field = field,
                label = labelText,
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
            )

            JoinFieldType.Textarea -> TextAreaField(
                field = field,
                label = labelText,
                value = value,
                onValueChange = onValueChange,
            )

            JoinFieldType.Number -> NumberInputField(
                field = field,
                label = labelText,
                value = value,
                onValueChange = onValueChange,
            )

            JoinFieldType.Select -> SelectField(
                field = field,
                label = labelText,
                value = value,
                onValueChange = onValueChange,
            )

            JoinFieldType.Multiselect -> MultiselectField(
                field = field,
                label = labelText,
                value = value,
                onValueChange = onValueChange,
            )

            JoinFieldType.Checkbox -> CheckboxField(
                field = field,
                value = value,
                onValueChange = onValueChange,
            )

            JoinFieldType.Date -> DateField(
                field = field,
                label = labelText,
                value = value,
                onValueChange = onValueChange,
            )

            JoinFieldType.File -> {
                // Mobile file uploads are a decision point (issue #768): rather
                // than the old disabled-but-editable text field (which accepted
                // typed input that was silently discarded on submit), this is a
                // genuinely disabled field with an explicit "Coming soon" label.
                // Decision: keep disabled for now — Android has no file picker,
                // upload flow, or attachment-encryption wiring for reports yet
                // (packages/crypto file-key labels exist and are used elsewhere,
                // but there is no ViewModel/API path for it in apps/android/).
                // Required file fields are excluded from the required-fields
                // check above so this never blocks report submission.
                FileUploadUnavailableField(field = field)
            }

            JoinFieldType.Location -> {
                LocationPickerField(
                    field = field,
                    label = labelText,
                    value = value,
                    onValueChange = onValueChange,
                    onSearch = onSearchLocation,
                )
            }
        }

        // Help text below the field
        if (field.helpText != null) {
            Text(
                text = field.helpText,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                modifier = Modifier
                    .padding(start = 4.dp, top = 4.dp)
                    .testTag("field-help-${field.name}"),
            )
        }
    }
}

// ---- Field Type Composables ----

/**
 * Placeholder for `file`-typed fields, which mobile does not support yet.
 *
 * Rendered as a genuinely disabled field (not an editable one) so the user
 * cannot type an attachment reference that gets silently dropped on submit.
 * The "Coming soon" copy ([R.string.report_file_coming_soon]) signals this is
 * a temporary gap, not a permanent desktop-only restriction — see the
 * JoinFieldType.File decision comment in DynamicField above.
 *
 * Uses `supportingText`, not `placeholder`: Material3's OutlinedTextField
 * only draws its placeholder when the field is focused or has non-empty
 * content (otherwise the label sits in that same space) — a field that is
 * both disabled and always empty can never satisfy either condition, so a
 * `placeholder`-only "Coming soon" would never actually render.
 */
@Composable
private fun FileUploadUnavailableField(
    field: ReportTypeDefinitionField,
    modifier: Modifier = Modifier,
) {
    OutlinedTextField(
        value = "",
        onValueChange = {},
        enabled = false,
        readOnly = true,
        label = { Text(field.label) },
        supportingText = { Text(stringResource(R.string.report_file_coming_soon)) },
        singleLine = true,
        modifier = modifier
            .fillMaxWidth()
            .testTag("field-${field.name}"),
    )
}

@Composable
private fun TextInputField(
    field: ReportTypeDefinitionField,
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    singleLine: Boolean,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = singleLine,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("field-${field.name}"),
    )
}

@Composable
private fun TextAreaField(
    field: ReportTypeDefinitionField,
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
) {
    Column {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            label = { Text(label) },
            minLines = 4,
            modifier = Modifier
                .fillMaxWidth()
                .testTag("field-${field.name}"),
        )

        // Audio input button for fields that support it
        if (field.supportAudioInput) {
            Spacer(Modifier.height(4.dp))
            AudioInputButton(
                currentText = value,
                onTextUpdate = onValueChange,
                testTagPrefix = "field-${field.name}",
                modifier = Modifier.testTag("field-${field.name}-audio"),
            )
        }
    }
}

@Composable
private fun NumberInputField(
    field: ReportTypeDefinitionField,
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
) {
    OutlinedTextField(
        value = value,
        onValueChange = { newValue ->
            // Only allow numeric input (digits and decimal point)
            val filtered = newValue.filter { it.isDigit() || it == '.' }
            // Prevent multiple decimal points
            val dotCount = filtered.count { it == '.' }
            if (dotCount <= 1) {
                onValueChange(filtered)
            }
        },
        label = { Text(label) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier
            .fillMaxWidth()
            .testTag("field-${field.name}"),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SelectField(
    field: ReportTypeDefinitionField,
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val options = field.options ?: emptyList()
    val displayValue = options.find { it.key == value }?.label ?: value

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = it },
        modifier = Modifier.testTag("field-${field.name}-dropdown"),
    ) {
        OutlinedTextField(
            value = displayValue,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            placeholder = { Text(stringResource(R.string.report_typed_select_option)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(MenuAnchorType.PrimaryNotEditable)
                .testTag("field-${field.name}"),
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label) },
                    onClick = {
                        onValueChange(option.key)
                        expanded = false
                    },
                    modifier = Modifier.testTag("field-${field.name}-option-${option.key}"),
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MultiselectField(
    field: ReportTypeDefinitionField,
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
) {
    val options = field.options ?: emptyList()
    // Value is stored as comma-separated list of selected option keys
    val selectedValues = if (value.isBlank()) emptySet()
    else value.split(",").map { it.trim() }.toSet()

    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier
                .padding(start = 4.dp, bottom = 8.dp)
                .testTag("field-${field.name}-label"),
        )

        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.testTag("field-${field.name}"),
        ) {
            options.forEach { option ->
                val isSelected = option.key in selectedValues
                FilterChip(
                    selected = isSelected,
                    onClick = {
                        val newSelected = if (isSelected) {
                            selectedValues - option.key
                        } else {
                            selectedValues + option.key
                        }
                        onValueChange(newSelected.joinToString(","))
                    },
                    label = { Text(option.label) },
                    modifier = Modifier.testTag("field-${field.name}-chip-${option.key}"),
                )
            }
        }
    }
}

@Composable
private fun CheckboxField(
    field: ReportTypeDefinitionField,
    value: String,
    onValueChange: (String) -> Unit,
) {
    val isChecked = value.equals("true", ignoreCase = true)

    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("field-${field.name}"),
    ) {
        Checkbox(
            checked = isChecked,
            onCheckedChange = { checked ->
                onValueChange(if (checked) "true" else "false")
            },
            modifier = Modifier.testTag("field-${field.name}-checkbox"),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = field.label,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (field.required) {
            Text(
                text = " *",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateField(
    field: ReportTypeDefinitionField,
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
) {
    var showDatePicker by remember { mutableStateOf(false) }
    val datePickerState = rememberDatePickerState()
    val dateFormat = remember { SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()) }

    OutlinedTextField(
        value = value,
        onValueChange = {},
        readOnly = true,
        label = { Text(label) },
        placeholder = { Text(stringResource(R.string.report_typed_date_pick)) },
        trailingIcon = {
            IconButton(
                onClick = { showDatePicker = true },
                modifier = Modifier.testTag("field-${field.name}-calendar-button"),
            ) {
                Icon(
                    imageVector = Icons.Filled.CalendarToday,
                    contentDescription = stringResource(R.string.report_typed_date_pick),
                    modifier = Modifier.size(20.dp),
                )
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .testTag("field-${field.name}"),
    )

    if (showDatePicker) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(
                    onClick = {
                        val millis = datePickerState.selectedDateMillis
                        if (millis != null) {
                            onValueChange(dateFormat.format(Date(millis)))
                        }
                        showDatePicker = false
                    },
                    modifier = Modifier.testTag("field-${field.name}-date-confirm"),
                ) {
                    Text("OK")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { showDatePicker = false },
                    modifier = Modifier.testTag("field-${field.name}-date-dismiss"),
                ) {
                    Text(stringResource(R.string.reports_back))
                }
            },
        ) {
            DatePicker(
                state = datePickerState,
                modifier = Modifier.testTag("field-${field.name}-date-picker"),
            )
        }
    }
}
