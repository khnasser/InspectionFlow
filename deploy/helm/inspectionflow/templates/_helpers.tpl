{{- define "if.name" -}}{{ .Release.Name }}{{- end -}}
{{- define "if.labels" -}}
app.kubernetes.io/name: inspectionflow
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "if.selector" -}}
app.kubernetes.io/name: inspectionflow
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "if.apiImage" -}}{{ .Values.image.api.repository }}:{{ .Values.image.api.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "if.webImage" -}}{{ .Values.image.web.repository }}:{{ .Values.image.web.tag | default .Chart.AppVersion }}{{- end -}}
{{- define "if.secretName" -}}{{ .Values.secrets.existingSecret | default (printf "%s-secrets" .Release.Name) }}{{- end -}}
{{- define "if.serviceAccount" -}}{{ .Values.serviceAccount.name | default (printf "%s" .Release.Name) }}{{- end -}}

{{/* Environment shared by the API, the worker and the migration job. */}}
{{- define "if.env" -}}
- name: NODE_ENV
  value: production
- name: PORT
  value: "3000"
- name: PUBLIC_BASE_URL
  value: https://{{ .Values.host }}
- name: VERIFY_BASE_URL
  value: https://{{ .Values.host }}
- name: CORS_ORIGIN
  value: {{ .Values.config.CORS_ORIGIN | default (printf "https://%s" .Values.host) | quote }}
{{- if .Values.gotenberg.enabled }}
- name: GOTENBERG_URL
  value: http://{{ .Release.Name }}-gotenberg:3000
{{- end }}
{{- range $k, $v := .Values.config }}
{{- if and $v (ne $k "CORS_ORIGIN") }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "if.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: { drop: [ALL] }
{{- end -}}
