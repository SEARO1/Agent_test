import React, { useState, useRef } from 'react';

interface JsonUploaderProps {
  onJsonLoaded: (data: any) => void;
}

export default function JsonUploader({ onJsonLoaded }: JsonUploaderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    processFile(file);
  };

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      try {
        const parsedJson = JSON.parse(reader.result as string);
        onJsonLoaded(parsedJson);
      } catch (error) {
        console.error("File is not valid JSON", error);
        alert("Invalid JSON file");
      }
    };
    reader.readAsText(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type === 'application/json') {
      processFile(file);
    } else {
      alert("Please drop a .json file");
    }
  };

  const handleClick = () => {
    inputRef.current?.click();
  };

  return (
    <div
      className={`upload-container ${isDragging ? 'dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
    >
      <div className="upload-icon">📂</div>
      <h3>Upload Knowledge Base JSON</h3>
      <p>Drag & drop your JSON file here, or click to browse</p>
      <input
        ref={inputRef}
        type="file"
        accept=".json"
        onChange={handleFileUpload}
        className="upload-input"
      />
    </div>
  );
}