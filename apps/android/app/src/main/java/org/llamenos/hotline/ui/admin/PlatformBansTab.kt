package org.llamenos.hotline.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.llamenos.hotline.R
import org.llamenos.hotline.model.BanEntry
import org.llamenos.hotline.model.identifierHash
import org.llamenos.hotline.model.id

@Composable
fun PlatformBansTab(
    viewModel: AdminViewModel,
    modifier: Modifier = Modifier,
) {
    val uiState by viewModel.uiState.collectAsState()
    var addIdentifierHash by remember { mutableStateOf("") }
    var addReason by remember { mutableStateOf("") }
    var banToRemove by remember { mutableStateOf<BanEntry?>(null) }

    // Removing a platform ban re-admits the caller on every hub: ask first (#2540). The dialog is
    // the only thing that mints the confirmation `removePlatformBan` requires, and the list and
    // the search results share it.
    banToRemove?.let { ban ->
        DeletionConfirmed.Dialog(
            action = AdminDeletion.PLATFORM_BAN,
            targetId = ban.id,
            subject = listOfNotNull(ban.identifierHash.take(16) + "...", ban.reason.takeIf { it.isNotBlank() })
                .joinToString(" · "),
            onConfirmed = {
                banToRemove = null
                viewModel.removePlatformBan(ban.id, it)
            },
            onDismiss = { banToRemove = null },
        )
    }

    // Add platform ban dialog
    if (uiState.showAddPlatformBanDialog) {
        AlertDialog(
            onDismissRequest = { viewModel.dismissAddPlatformBanDialog() },
            title = { Text(stringResource(R.string.platform_bans_create_button)) },
            text = {
                Column {
                    OutlinedTextField(
                        value = addIdentifierHash,
                        onValueChange = { addIdentifierHash = it },
                        label = { Text(stringResource(R.string.platform_bans_search_placeholder)) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("platform-ban-hash-input"),
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = addReason,
                        onValueChange = { addReason = it },
                        label = { Text(stringResource(R.string.admin_ban_reason_label)) },
                        singleLine = true,
                        modifier = Modifier
                            .fillMaxWidth()
                            .testTag("platform-ban-reason-input"),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.addPlatformBan(addIdentifierHash, addReason)
                        addIdentifierHash = ""
                        addReason = ""
                    },
                    enabled = addIdentifierHash.isNotBlank(),
                    modifier = Modifier.testTag("confirm-platform-ban"),
                ) {
                    Text(stringResource(R.string.platform_bans_create_button))
                }
            },
            dismissButton = {
                TextButton(
                    onClick = { viewModel.dismissAddPlatformBanDialog() },
                    modifier = Modifier.testTag("cancel-platform-ban"),
                ) {
                    Text(stringResource(android.R.string.cancel))
                }
            },
            modifier = Modifier.testTag("add-platform-ban-dialog"),
        )
    }

    Scaffold(
        floatingActionButton = {
            FloatingActionButton(
                onClick = { viewModel.showAddPlatformBanDialog() },
                modifier = Modifier.testTag("add-platform-ban-fab"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Add,
                    contentDescription = stringResource(R.string.platform_bans_create_button),
                )
            }
        },
        modifier = modifier,
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
        ) {
            // Search bar
            OutlinedTextField(
                value = uiState.platformBanSearchQuery,
                onValueChange = { viewModel.setPlatformBanSearchQuery(it) },
                label = { Text(stringResource(R.string.platform_bans_search_placeholder)) },
                leadingIcon = {
                    Icon(Icons.Filled.Search, contentDescription = null)
                },
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 8.dp)
                    .testTag("platform-ban-search"),
            )

            when {
                uiState.isLoadingPlatformBans -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("platform-bans-loading"),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.platformBans.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp)
                            .testTag("platform-bans-empty"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Icon(
                                imageVector = Icons.Filled.Block,
                                contentDescription = null,
                                modifier = Modifier.size(48.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            )
                            Spacer(Modifier.height(12.dp))
                            Text(
                                text = stringResource(R.string.platform_bans_empty_state),
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(Modifier.height(8.dp))
                            Text(
                                text = stringResource(R.string.platform_bans_empty_state_description),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                            )
                        }
                    }
                }

                else -> {
                    // Search results
                    if (uiState.platformBanSearchResults.isNotEmpty()) {
                        LazyColumn(
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.testTag("platform-ban-search-results"),
                        ) {
                            items(
                                items = uiState.platformBanSearchResults,
                                key = { it.id },
                            ) { ban ->
                                PlatformBanCard(
                                    ban = ban,
                                    onRemove = { banToRemove = ban },
                                )
                            }
                        }
                    }

                    // Platform bans list
                    LazyColumn(
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier
                            .fillMaxSize()
                            .testTag("platform-bans-list"),
                    ) {
                        items(
                            items = uiState.platformBans,
                            key = { it.id },
                        ) { ban ->
                            PlatformBanCard(
                                ban = ban,
                                onRemove = { banToRemove = ban },
                            )
                        }
                    }
                }
            }

            if (uiState.platformBansError != null) {
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp)
                        .testTag("platform-bans-error"),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Text(
                        text = uiState.platformBansError ?: "",
                        modifier = Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.onErrorContainer,
                    )
                }
            }
        }
    }
}

@Composable
private fun PlatformBanCard(
    ban: BanEntry,
    onRemove: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .testTag("platform-ban-card-${ban.id}"),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                imageVector = Icons.Filled.Block,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(24.dp),
            )

            Spacer(Modifier.width(12.dp))

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = ban.identifierHash.take(16) + "...",
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("platform-ban-hash-${ban.id}"),
                )

                if (!ban.reason.isNullOrBlank()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = ban.reason,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            IconButton(
                onClick = onRemove,
                modifier = Modifier.testTag("remove-platform-ban-${ban.id}"),
            ) {
                Icon(
                    imageVector = Icons.Filled.Delete,
                    contentDescription = stringResource(R.string.ban_list_remove),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}
