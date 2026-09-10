// Exclusivo dos testes isolados no runner Linux: não altera a configuração
// de segurança do aplicativo distribuído nem de perfis reais de usuário.
export const testElectronArgs = process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [];
