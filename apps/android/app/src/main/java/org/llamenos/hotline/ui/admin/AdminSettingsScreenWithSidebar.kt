package org.llamenos.hotline.ui.admin

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.hilt.navigation.compose.hiltViewModel
import org.llamenos.hotline.R

/**
 * One admin section (call settings, bans, retention, ...) opened from the admin
 * sidebar. The section comes from the route argument, which [AdminViewModel]
 * reads on creation; the drawer here switches section by navigating, so back
 * always returns to the admin panel.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdminSettingsScreenWithSidebar(
    onNavigateBack: () -> Unit,
    onNavigateToAdminSection: (String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: AdminViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsState()
    val section = uiState.selectedAdminSection

    AdminSidebarDrawerHost(
        selectedSlug = section,
        onNavigateToAdminSection = onNavigateToAdminSection,
        modifier = modifier,
    ) { openDrawer ->
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            text = stringResource(AdminNavConfig.itemFor(section)?.labelRes ?: R.string.admin_title),
                            modifier = Modifier.testTag("admin-section-title"),
                        )
                    },
                    navigationIcon = {
                        IconButton(
                            onClick = onNavigateBack,
                            modifier = Modifier.testTag("admin-section-back"),
                        ) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.common_back),
                            )
                        }
                    },
                    actions = {
                        AdminSidebarToggle(onClick = openDrawer)
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.secondaryContainer,
                        titleContentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                    ),
                )
            },
        ) { paddingValues ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues),
            ) {
                AdminSectionHost(viewModel = viewModel)
            }
        }
    }
}
