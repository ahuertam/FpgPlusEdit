PROGRAM ejemplo_circuito;

// Un triangulo que recorre el circuito que hay dibujado de fondo.
//
// El circuito (el grafico 1 del fichero) lleva doce puntos de control
// colocados con FPG+ Edit: son los que el programa va siguiendo uno detras de
// otro. El triangulo (el grafico 2) gira hacia el punto que le toca.
//
// Los ficheros de DIV son ASCII con finales de linea CRLF, como los que trae
// el propio DIV Games Studio: por eso aqui no hay tildes.

GLOBAL
    fichero;         // codigo del fichero de graficos, lo devuelve load_fpg
    punto=1;         // numero del punto de control al que se dirige
    x_punto;         // coordenadas del punto de control, las pone get_point
    y_punto;

BEGIN
    set_mode(m320x200);

    // Los graficos y la paleta. Los dos ficheros tienen que estar en la
    // misma carpeta que este programa.
    fichero=load_fpg("ejemplo.fpg");
    load_pal("ejemplo.pal");

    // El circuito, de fondo: el grafico 1 del fichero, en (0,0).
    put(fichero, 1, 0, 0);

    // El triangulo, que es lo que se mueve.
    graph=2;
    x=160;
    y=30;

    LOOP
        // El punto de control al que se dirige ahora mismo.
        get_point(fichero, 1, punto, offset x_punto, offset y_punto);

        // Ya esta encima? Entonces al siguiente, y a otra.
        IF (fget_dist(x, y, x_punto, y_punto)<8)
            IF (punto++==12) punto=1; END
            get_point(fichero, 1, punto, offset x_punto, offset y_punto);
        END

        // El angulo hacia ese punto, y tres pixeles en esa direccion.
        angle=fget_angle(x, y, x_punto, y_punto);
        advance(3);

        // Y a mostrar el fotograma.
        FRAME;
    END
END
