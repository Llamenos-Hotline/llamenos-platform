export const download: Record<string, {
  title: string;
  subtitle: string;
  recommended: string;
  allPlatforms: string;
  version: string;
  releaseNotes: string;
  checksum: string;
  verifyTitle: string;
  verifySubtitle: string;
  verifyMinisign: string;
  verifySha256: string;
  verifyAttestation: string;
  verifyAudit: string;
  copyCommand: string;
  copied: string;
  platforms: {
    windows: { name: string; description: string };
    macos: { name: string; description: string };
    linuxAppImage: { name: string; description: string };
    linuxDeb: { name: string; description: string };
    linuxRpm: { name: string; description: string };
    mobile: { name: string; description: string };
  };
  macosUnsigned: string;
  loadError: string;
  downloadApk: string;
  systemReqs: string;
  reqItems: string[];
}> = {
  en: {
    title: 'Download Hotline',
    subtitle: 'Secure, encrypted crisis response software for your desktop. Verify every build.',
    recommended: 'Recommended for your system',
    allPlatforms: 'All platforms',
    version: 'Latest version',
    releaseNotes: 'Release notes',
    checksum: 'Verify checksums',
    verifyTitle: 'Verify your download',
    verifySubtitle: 'Every installer is signed with the project’s minisign key and accompanied by SHA-256 checksums on the same release. Verify before you install.',
    verifyMinisign: 'Minisign signature',
    verifySha256: 'SHA-256 checksum',
    verifyAttestation: 'Build attestation (SLSA)',
    verifyAudit: 'Full audit trail',
    copyCommand: 'Copy',
    copied: 'Copied',
    platforms: {
      windows: { name: 'Windows', description: 'Windows 10+ (64-bit) installer' },
      macos: { name: 'macOS', description: 'macOS 11+ universal binary (Intel + Apple Silicon)' },
      linuxAppImage: { name: 'Linux AppImage', description: 'Portable, runs on most distributions' },
      linuxDeb: { name: 'Linux .deb', description: 'Debian, Ubuntu, and derivatives' },
      linuxRpm: { name: 'Linux .rpm', description: 'Fedora, RHEL, openSUSE, and derivatives' },
      mobile: { name: 'Mobile', description: 'Early access — Android APK and iOS TestFlight available' },
    },
    macosUnsigned: 'No signed macOS build yet (see #741) — without Apple notarization, Gatekeeper would refuse to open it.',
    loadError: 'Could not load the latest release. Download directly from GitHub Releases:',
    downloadApk: 'Download Android APK',
    systemReqs: 'System requirements',
    reqItems: [
      'Windows 10+, macOS 11+, or Linux with WebKitGTK 4.1',
      'Network connection to your hotline server',
      '4-digit PIN for key encryption',
    ],
  },
  es: {
    title: 'Descargar Hotline',
    subtitle: 'Software seguro y cifrado de respuesta a crisis para tu escritorio. Verifica cada compilación.',
    recommended: 'Recomendado para tu sistema',
    allPlatforms: 'Todas las plataformas',
    version: 'Ultima version',
    releaseNotes: 'Notas de la version',
    checksum: 'Verificar checksums',
    verifyTitle: 'Verifica tu descarga',
    verifySubtitle: 'Cada instalador está firmado con la clave minisign del proyecto y acompañado de checksums SHA-256 en la misma versión. Verifica antes de instalar.',
    verifyMinisign: 'Firma Minisign',
    verifySha256: 'Suma de verificación SHA-256',
    verifyAttestation: 'Atestación de compilación (SLSA)',
    verifyAudit: 'Auditoría completa',
    copyCommand: 'Copiar',
    copied: 'Copiado',
    platforms: {
      windows: { name: 'Windows', description: 'Windows 10+ (64 bits) instalador' },
      macos: { name: 'macOS', description: 'macOS 11+ binario universal (Intel + Apple Silicon)' },
      linuxAppImage: { name: 'Linux AppImage', description: 'Portable, funciona en la mayoria de distribuciones' },
      linuxDeb: { name: 'Linux .deb', description: 'Debian, Ubuntu y derivados' },
      linuxRpm: { name: 'Linux .rpm', description: 'Fedora, RHEL, openSUSE y derivados' },
      mobile: { name: 'Movil', description: 'Acceso anticipado — APK Android y TestFlight iOS disponibles' },
    },
    macosUnsigned: 'Aún no hay una compilación firmada para macOS (véase #741): Gatekeeper rechazaría una compilación sin notarización de Apple.',
    loadError: 'No se pudo cargar la última versión. Descarga directamente desde GitHub Releases:',
    downloadApk: 'Descargar APK de Android',
    systemReqs: 'Requisitos del sistema',
    reqItems: [
      'Windows 10+, macOS 11+, o Linux con WebKitGTK 4.1',
      'Conexion de red a tu servidor de linea de ayuda',
      'PIN de 4 digitos para cifrado de claves',
    ],
  },
  zh: {
    title: '下载 Hotline',
    subtitle: '安全加密的危机响应桌面软件。验证每个构建。',
    recommended: '推荐适合您的系统',
    allPlatforms: '所有平台',
    version: '最新版本',
    releaseNotes: '发布说明',
    checksum: '验证校验和',
    verifyTitle: '验证您的下载',
    verifySubtitle: '每个安装程序均使用项目的 minisign 密钥签名，并在同一版本中附带 SHA-256 校验和。安装前请验证。',
    verifyMinisign: 'Minisign 签名',
    verifySha256: 'SHA-256 校验和',
    verifyAttestation: '构建溯源证明 (SLSA)',
    verifyAudit: '完整审计记录',
    copyCommand: '复制',
    copied: '已复制',
    platforms: {
      windows: { name: 'Windows', description: 'Windows 10+ (64位) 安装程序' },
      macos: { name: 'macOS', description: 'macOS 11+ 通用二进制 (Intel + Apple Silicon)' },
      linuxAppImage: { name: 'Linux AppImage', description: '便携式，适用于大多数发行版' },
      linuxDeb: { name: 'Linux .deb', description: 'Debian、Ubuntu 及其衍生版' },
      linuxRpm: { name: 'Linux .rpm', description: 'Fedora、RHEL、openSUSE 及衍生版' },
      mobile: { name: '移动端', description: '即将推出 — iOS 和 Android 应用正在开发中' },
    },
    macosUnsigned: '暂无已签名的 macOS 构建（见 #741）— 未经 Apple 公证的构建会被 Gatekeeper 拦截。',
    loadError: '无法加载最新版本信息。请直接从 GitHub Releases 下载：',
    downloadApk: '下载 Android APK',
    systemReqs: '系统要求',
    reqItems: [
      'Windows 10+、macOS 11+ 或带有 WebKitGTK 4.1 的 Linux',
      '与热线服务器的网络连接',
      '用于密钥加密的 4 位 PIN 码',
    ],
  },
  // Other languages fall back to English via getTranslation()
};
