import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/** Finger signature captured as SVG path data; the path is hashed into the record. */
export function SignaturePad({ onChange, height = 160 }: { onChange: (pathData: string | null) => void; height?: number }) {
  const [paths, setPaths] = useState<string[]>([]);
  const current = useRef<string>('');

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const { locationX: x, locationY: y } = e.nativeEvent;
        current.current = `M${x.toFixed(1)} ${y.toFixed(1)}`;
        setPaths((p) => [...p, current.current]);
      },
      onPanResponderMove: (e) => {
        const { locationX: x, locationY: y } = e.nativeEvent;
        current.current += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
        setPaths((p) => [...p.slice(0, -1), current.current]);
      },
      onPanResponderRelease: () => {
        setPaths((p) => {
          onChange(p.join(' '));
          return p;
        });
      },
    }),
  ).current;

  return (
    <View style={[styles.pad, { height }]} {...responder.panHandlers}>
      <Svg width="100%" height="100%">
        {paths.map((d, i) => (
          <Path key={i} d={d} stroke="#0b2545" strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </Svg>
    </View>
  );
}

export function clearSignature(setter: (v: null) => void) {
  setter(null);
}

const styles = StyleSheet.create({
  pad: { borderWidth: 1, borderColor: '#c9ced6', borderRadius: 8, backgroundColor: '#fff', overflow: 'hidden' },
});
