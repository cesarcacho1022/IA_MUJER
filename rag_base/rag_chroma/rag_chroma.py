"""Simulación de un RAG con ChromaDB.

- Extrae el texto de los PDFs de la carpeta rag_base.
- Divide el texto en fragmentos (chunks) con solapamiento.
- Vectoriza con HashingVectorizer (scikit-learn, sin modelos externos ni APIs).
- Guarda los vectores en ChromaDB con métrica de coseno.
- Dada una pregunta, recupera los fragmentos más próximos (similitud coseno).
"""
import re
import sys
from pathlib import Path

import chromadb
from pypdf import PdfReader
from sklearn.feature_extraction.text import HashingVectorizer

BASE_DIR = Path(__file__).resolve().parent
PDF_DIR = BASE_DIR.parent
DB_DIR = BASE_DIR / "chroma_db"
COLLECTION = "leyes_mujer"
CHUNK_SIZE = 800
OVERLAP = 150
N_FEATURES = 4096

# Vectorizador de dimensión fija (no requiere entrenamiento); salida normalizada L2.
vectorizer = HashingVectorizer(
    n_features=N_FEATURES,
    lowercase=True,
    strip_accents="unicode",
    ngram_range=(1, 2),
    alternate_sign=False,
    norm="l2",
)


def embed(texts):
    return vectorizer.transform(texts).toarray().tolist()


def read_pdf(path):
    reader = PdfReader(str(path))
    return [(i + 1, p.extract_text() or "") for i, p in enumerate(reader.pages)]


def chunk_text(text):
    text = re.sub(r"\s+", " ", text).strip()
    step = CHUNK_SIZE - OVERLAP
    return [text[i:i + CHUNK_SIZE] for i in range(0, len(text), step) if text[i:i + CHUNK_SIZE].strip()]


def build_index(collection):
    ids, docs, metas = [], [], []
    for pdf in sorted(PDF_DIR.glob("*.pdf")):
        for page, text in read_pdf(pdf):
            for n, chunk in enumerate(chunk_text(text)):
                ids.append(f"{pdf.stem}-p{page}-c{n}")
                docs.append(chunk)
                metas.append({"fuente": pdf.name, "pagina": page})
    for i in range(0, len(docs), 200):
        s = slice(i, i + 200)
        collection.add(ids=ids[s], documents=docs[s], metadatas=metas[s], embeddings=embed(docs[s]))
    print(f"Indexados {len(docs)} fragmentos.")


def query(collection, pregunta, k=3):
    res = collection.query(query_embeddings=embed([pregunta]), n_results=k)
    print(f"\nPregunta: {pregunta}\n")
    for doc, meta, dist in zip(res["documents"][0], res["metadatas"][0], res["distances"][0]):
        # En Chroma, distancia coseno = 1 - similitud coseno
        print(f"[similitud coseno={1 - dist:.4f}] {meta['fuente']} (pág. {meta['pagina']})")
        print(f"{doc}\n{'-' * 80}")


def main():
    client = chromadb.PersistentClient(path=str(DB_DIR))
    collection = client.get_or_create_collection(COLLECTION, metadata={"hnsw:space": "cosine"})
    if collection.count() == 0:
        build_index(collection)
    pregunta = " ".join(sys.argv[1:]) or "¿Qué medidas de protección se pueden dictar para una víctima de violencia?"
    query(collection, pregunta)


if __name__ == "__main__":
    main()
