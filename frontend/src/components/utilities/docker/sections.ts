// Las secciones de la utilidad Docker. Viven en un módulo aparte porque las usan
// dos lugares que no se importan entre sí: el submenú de la barra lateral (que
// elige la sección) y la pestaña (que la muestra).
export type DockerSection = 'containers' | 'images' | 'volumes' | 'networks' | 'builds'

export const DOCKER_SECTIONS: {id: DockerSection; icon: string}[] = [
    {id: 'containers', icon: 'inventory_2'},
    {id: 'images', icon: 'layers'},
    {id: 'volumes', icon: 'hard_drive'},
    {id: 'networks', icon: 'hub'},
    {id: 'builds', icon: 'construction'},
]
