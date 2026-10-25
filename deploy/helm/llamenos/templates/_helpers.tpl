{{/*
Expand the name of the chart.
*/}}
{{- define "llamenos.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "llamenos.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "llamenos.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "llamenos.labels" -}}
helm.sh/chart: {{ include "llamenos.chart" . }}
{{ include "llamenos.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.app.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "llamenos.selectorLabels" -}}
app.kubernetes.io/name: {{ include "llamenos.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "llamenos.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "llamenos.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
App image tag
*/}}
{{- define "llamenos.appImageTag" -}}
{{- .Values.app.image.tag | default .Chart.AppVersion }}
{{- end }}

{{/*
Secret name
*/}}
{{/*
Name of the Secret holding the ban-list hash key (BAN_HASH_KEY, D6). A Secret of
its own, never a key inside "-secrets": the app mounts it as a FILE at
/run/secrets/ban-hash-key and refuses it as an environment variable, so it must
not ride along with anything that is exported as env or bundled for backup.
*/}}
{{- define "llamenos.banHashKeySecretName" -}}
{{- if .Values.secrets.existingBanHashKeySecret }}
{{- .Values.secrets.existingBanHashKeySecret }}
{{- else }}
{{- include "llamenos.fullname" . }}-ban-hash-key
{{- end }}
{{- end }}

{{- define "llamenos.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- include "llamenos.fullname" . }}-secrets
{{- end }}
{{- end }}
