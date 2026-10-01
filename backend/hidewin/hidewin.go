// Package hidewin evita que un proceso hijo abra una consola a la vista en
// Windows. La app es de ventana y no tiene una consola que heredar, así que
// sin esto cada `netstat`/`docker` hace parpadear una. Fuera de Windows no hace
// nada.
package hidewin
